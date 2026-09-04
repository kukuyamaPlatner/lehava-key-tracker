# Key Tracker — Migration Brief (Apps Script → GitHub Pages + Supabase)

## Context

A working prototype of this system already exists as a Google Apps Script
web app (bound to a Sheet called "Lehave Keys Tracking"). It works, but is
slow (1–3s per page load, Apps Script cold starts) and every code change
requires manually copy-pasting files into the Apps Script editor and
clicking through a deploy flow. The goal now is to rebuild the same
functionality on **GitHub Pages (static hosting) + Supabase (Postgres +
instant API)**, keeping the exact same behavior and UI language (Hebrew,
RTL, mobile-first) but with a real deploy pipeline (`git push`).

The `apps-script-reference/` files included alongside this brief are the
**working, tested version of the logic** — treat them as the source of
truth for behavior, states, and edge cases. Don't redesign from scratch;
port them.

## What this system is

Teachers at a school tap an NFC-tagged key with their phone. It opens a
web page that logs who took it and who returned it. No physical locks —
the point is removing friction so people actually log it, not enforcement.

## Data model (port as-is to Postgres via Supabase schema)

Three tables, matching the original Sheet tabs exactly:

**`keys`**: `key_id` (text, PK), `name`, `location`, `status` ('in'|'out'),
`holder` (user_id, nullable), `last_updated` (timestamptz), `active` (bool)

**`log`** (append-only, source of truth): `id` (serial/uuid PK),
`timestamp`, `key_id`, `user_id`, `user_name`, `action` ('out'|'in'),
`method` ('auto'|'manual'), `note`

**`users`**: `user_id` (text, PK), `name`, `active` (bool)

**Important invariant carried over from the Apps Script version:** the log
is the source of truth; `keys.status`/`keys.holder` is a cached rollup.
Every write does log-append first, then updates the `keys` row — in that
order, because a failure after the log write is recoverable (rebuild from
log) but the reverse isn't. Include a `rebuild_status_from_log()` admin
function that replays the log and recomputes every key's cached status,
same as `adminRebuildStatus` in the reference code.

## Screens (3, same as reference)

### 1. Scan screen (`?k=<key_id>`) — the main one, optimize this above all

**Identity: typed name, not a dropdown.** This was a deliberate change from
an earlier version. Flow:
- First visit on a device: text input, "who are you?", they type their name
- Live autocomplete suggestions appear as they type (existing user names
  containing their input) — tapping one identifies them immediately, no
  further confirmation needed
- If they type a full name and hit continue, and it **exactly matches**
  (case/whitespace-insensitive) an existing user, ask **"is this you?"**
  with Yes/No — don't silently merge, because duplicate teacher names are
  expected (e.g. two "Moshe Cohen"s)
- "No, someone else" → prompts them to add a distinguishing detail (e.g.
  subject taught), pre-filled with what they typed + a dash, cursor at the
  end. Re-checks the new name; loops back to the same confirm step if it's
  *still* a collision
- Once resolved, store `{user_id, name}` in `localStorage` — every future
  visit on that device skips straight past this, no re-typing

**Key states after identity is known:**
- Key `in` → "Available" + big "Take this key" button
- Key `out`, held by current user → "You've had this since [time]" + "Return"
- Key `out`, held by someone else → shows who + duration, with **two
  options**: "Return it for [them]" (method: manual) or "Take it — I have
  it now" (a two-step log write: check in for them, check out for me, both
  method: manual) — this handles the case where someone forgot to check in
- Small "not [name]? switch user" link always available, clears
  localStorage and re-prompts

**Perceived-speed pattern to keep:** paint the shell instantly (key ID +
spinner), fetch state async, fill in. Don't block the first paint on a
network round trip — Supabase should make this mostly moot since it's fast,
but keep the pattern anyway, it's good practice.

### 2. Board screen (no params) — public, read-only

Table of all active keys: name, location, status, holder, duration.
Auto-refreshes every 30s (was `setInterval`, keep same behavior — useful
if left open on a wall tablet). Has a small button/link at the **top** of
the page (not bottom — this was explicitly moved) linking to the admin
login.

### 3. Admin screen (`?admin=1`)

**Auth: NOT Google OAuth, and NOT email-based.** We tried both and hit
real walls:
- Apps Script's `Session.getActiveUser()` doesn't reliably identify
  visitors outside a Google Workspace domain — a dead end there, though
  this constraint is specific to Apps Script, not Supabase, so revisit if
  it seems easy here.
- Full "Sign in with Google" was ruled out for the Apps Script version due
  to iframe sandboxing — **this constraint does NOT apply on GitHub
  Pages**, since it's a normal static origin. If you want to offer real
  Google Sign-In here as an upgrade, it's technically feasible now in a
  way it wasn't before. Otherwise, port the fallback below.

**What we landed on and should port by default:** a shared admin
passcode, entered once via a login *form* (not a URL parameter — explicitly
avoid `?admin=1&pass=xxx` in the URL, the person didn't want that), stored
in `localStorage` after success so it's a one-time login per device, with
a "log out" link to clear it. Every admin API call re-validates the
passcode server-side (in Supabase's case: a Postgres function or RLS
policy checking a passcode column, or a lightweight Edge Function) — the
login screen is UX, not the actual security boundary.

**Admin capabilities (all from the reference `Admin.html`/`Code.gs`):**
- Keys tab: list, add (auto-generates next `key_id` like `K07`), edit
  name/location, retire (soft delete via `active=false`)
- Users tab: list, add (auto-generates `user_id`), deactivate
- Live board tab: same as public board + a "force check-in" button per
  out key + the "rebuild status from log" button
- Reports tab: "currently out" list, "what does [teacher name] currently
  hold" lookup

## Stack specifics

- **GitHub Pages**: static hosting for `index.html` (scan+board combined,
  routed by query param same as Apps Script's `doGet` router) and
  `admin.html`. No build step — plain HTML/JS, same as the reference.
- **Supabase**: Postgres tables above, `anon` public key used directly from
  the browser (same trust model as Apps Script's "Anyone" deployment —
  scan/board are meant to be publicly writable within the app's own logic;
  don't over-engineer RLS beyond what's needed to keep the admin passcode
  functions server-side)
- Keep the RTL/Hebrew UI, the same button/card visual language, and the
  same file-per-screen structure as the reference for anyone comparing.

## What's explicitly out of scope (per original spec, still holds)

Physical locks, AirTag/BLE location tracking, notifications for overdue
keys, anything requiring an app install.

## Suggested build order

1. Supabase schema + the SQL functions for record-action /
   rebuild-status / admin passcode check
2. Scan screen end-to-end (this is 95% of real usage — get it right first)
3. Board screen
4. Admin screen with passcode login
5. Test on a real phone with a real NFC tag before considering it done
