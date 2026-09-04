# Key Tracker

School key-tracking app: teachers tap an NFC-tagged key with their phone,
which opens this site and logs who took it / returned it. Static site on
GitHub Pages + Supabase (Postgres) as the backend. No build step.

Originally an Apps Script + Google Sheets prototype; ported here per
`MIGRATION_BRIEF.md` (kept for the original behavior spec). The original
Apps Script code is preserved in `apps-script-reference/` for comparison —
it is not part of the deployed site.

## Architecture

- `index.html` — routes client-side between the **scan** screen (`?k=<key_id>`)
  and the **board** screen (no params), mirroring the old Apps Script `doGet`
  router. Loads `assets/scan.js` or `assets/board.js` depending on the query
  string.
- `admin.html` — passcode-gated admin UI (`assets/admin.js`).
- `assets/config.js` — public Supabase URL + anon key. Committed on purpose;
  the anon key is meant to be public (same trust model as the old Apps
  Script "Anyone" deployment). All real access control is server-side.
- `supabase/schema.sql` — the entire backend: 4 tables (`keys`, `log`,
  `users`, `admin_config`) and every RPC function the frontend calls.

**Access model**: all 4 base tables have RLS enabled with **zero policies**,
so the anon key cannot read/write them directly via PostgREST's table API.
Every operation — including plain reads like `get_board()` — goes through a
`SECURITY DEFINER` Postgres function, called via `supabase.rpc(name, args)`
from `assets/supabase-client.js`'s `rpc()` helper. This is deliberate: it
means the *only* way to touch data is through the specific operations
encoded in `schema.sql`, nothing broader.

**Log is the source of truth.** `keys.status` / `keys.holder` are a cached
rollup. Every mutating function inserts into `log` first, then updates
`keys` — in that order (a crash after the log write is recoverable via
`admin_rebuild_status()`; the reverse isn't). Don't reorder this if you
touch `record_action`, `record_swap`, or `admin_force_check_in`.

**Admin passcode** lives only in the `admin_config` table in Supabase, never
in this repo. Change it via the SQL editor:
```sql
update admin_config set passcode = 'new-passcode';
```
The `admin.html` login screen is UX only — every `admin_*` function
re-checks the passcode server-side via `admin_check_pass()`.

## Making schema changes

Edit `supabase/schema.sql`, then paste the whole file into the Supabase
SQL Editor and run it. It's written to be safely re-runnable (`create table
if not exists`, `create or replace function`), except the seed passcode
insert (`on conflict do nothing`, so it won't clobber a real passcode).

## Testing locally

No build step — just serve the directory and open it:
```sh
python3 -m http.server 8765
# http://localhost:8765/index.html          (board)
# http://localhost:8765/index.html?k=K01    (scan, once K01 exists)
# http://localhost:8765/admin.html
```
It talks to the real Supabase project in `assets/config.js` — there's no
separate local/dev database. Create a test key via the admin UI, and
retire/deactivate it when done rather than leaving test data live.

## Known gotcha: `onclick="..." ` + `JSON.stringify`

Several screens build HTML strings with inline `onclick="someFn(...)"`
handlers that take an object or string argument. If you ever pass a value
through `JSON.stringify()` directly into a **double-quoted** `onclick="..."`
attribute, the JSON's own `"` characters terminate the attribute early and
corrupt the tag — this was a real, silent bug in the original Apps Script
reference (broke the "is this you?" collision flow, name-suggestion taps,
swap actions, and admin edit-key). Always go through the `j()` helper
defined in `scan.js` / `admin.js`, which HTML-entity-escapes the quotes:
```js
'<button onclick="doThing(' + j(someValue) + ')">...</button>'
```
Don't reintroduce raw `JSON.stringify(...)` inside a double-quoted
attribute when adding new buttons.

## Deploy

`git push` to `main` — GitHub Pages serves directly from the branch root,
no CI/build step. Live in about a minute after push.
