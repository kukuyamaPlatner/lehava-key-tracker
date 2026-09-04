-- Key Tracker — Supabase schema
--
-- Paste this whole file into Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run: uses `create or replace` for functions, `if not exists` for tables.
--
-- Design:
--   - Base tables (keys, log, users, admin_config) have RLS enabled with NO
--     policies, so the anon key can never read/write them directly via the
--     REST API. All access goes through the functions below, each declared
--     SECURITY DEFINER so it runs with the owner's privileges and bypasses
--     RLS internally — but only the specific operation the function encodes
--     is possible from the browser, nothing more.
--   - The admin passcode lives in admin_config, checked server-side inside
--     admin_check_pass(); it is never sent back to the client and the table
--     itself is unreadable via the API.
--   - `log` is the source of truth. Every mutating function inserts into log
--     first, then updates `keys`, matching the Apps Script version's ordering
--     invariant (a crash after the log write is recoverable; the reverse isn't).

-- ============================================================================
-- 1. TABLES
-- ============================================================================

create table if not exists users (
  user_id text primary key,
  name text not null,
  active boolean not null default true
);

-- Only one *active* user may have a given name (case/whitespace-insensitive).
-- Inactive (deactivated) users are excluded so the name can be reused.
create unique index if not exists users_name_unique_active
  on users (lower(trim(name)))
  where active;

create table if not exists keys (
  key_id text primary key,
  name text not null,
  location text,
  status text not null default 'in' check (status in ('in', 'out')),
  holder text references users(user_id),
  last_updated timestamptz not null default now(),
  active boolean not null default true
);

create table if not exists log (
  id bigint generated always as identity primary key,
  timestamp timestamptz not null default now(),
  key_id text not null references keys(key_id),
  user_id text,
  user_name text,
  action text not null check (action in ('in', 'out')),
  method text not null default 'auto' check (method in ('auto', 'manual')),
  note text default ''
);

create index if not exists log_key_id_idx on log (key_id);
create index if not exists log_timestamp_idx on log ("timestamp");

-- Single-row table holding the shared admin passcode. The `id` boolean
-- primary key with a check constraint enforces at most one row.
create table if not exists admin_config (
  id boolean primary key default true check (id),
  passcode text not null
);

insert into admin_config (id, passcode)
values (true, 'CHANGE_ME')
on conflict (id) do nothing;

alter table users enable row level security;
alter table keys enable row level security;
alter table log enable row level security;
alter table admin_config enable row level security;
-- No policies are created for any table — anon/authenticated have zero
-- direct access. Everything below goes through SECURITY DEFINER functions.

-- ============================================================================
-- 2. HELPERS
-- ============================================================================

create or replace function admin_check_pass(p_pass text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pass is null or not exists (
    select 1 from admin_config where passcode = p_pass
  ) then
    raise exception 'Not authorized.';
  end if;
end;
$$;

-- ============================================================================
-- 3. PUBLIC API — scan screen
-- ============================================================================

create or replace function get_key_state(p_key_id text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  k keys%rowtype;
  v_holder_name text := '';
begin
  select * into k from keys where key_id = p_key_id and active is true;
  if not found then
    return json_build_object('found', false);
  end if;

  if k.status = 'out' and k.holder is not null then
    select name into v_holder_name from users where user_id = k.holder;
    if v_holder_name is null then
      v_holder_name := k.holder;
    end if;
  end if;

  return json_build_object(
    'found', true,
    'key_id', k.key_id,
    'name', k.name,
    'location', coalesce(k.location, ''),
    'status', coalesce(k.status, 'in'),
    'holder_id', coalesce(k.holder, ''),
    'holder_name', coalesce(v_holder_name, ''),
    'last_updated', k.last_updated
  );
end;
$$;

create or replace function get_users()
returns json
language sql
security definer
set search_path = public
as $$
  select coalesce(json_agg(json_build_object('user_id', user_id, 'name', name) order by name), '[]'::json)
  from users
  where active is true;
$$;

-- Returns existing active users whose name matches exactly
-- (case/whitespace-insensitive) — used to ask "is this you?" rather than
-- silently merging two different people with the same name.
create or replace function find_user_by_name(p_name text)
returns json
language sql
security definer
set search_path = public
as $$
  select coalesce(json_agg(json_build_object('user_id', user_id, 'name', name)), '[]'::json)
  from users
  where active is true
    and lower(trim(name)) = lower(trim(p_name));
$$;

-- Creates a new user unconditionally — used once the client has confirmed
-- this is a genuinely different person than any existing match. Still
-- guards against a duplicate created in the split second between the
-- client's check and this write (advisory lock + unique index).
create or replace function create_unique_user(p_name text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := trim(p_name);
  v_id text;
  v_max int;
begin
  if v_name is null or v_name = '' then
    raise exception 'Name is required.';
  end if;

  perform pg_advisory_xact_lock(hashtext('key_tracker:create_user'));

  if exists (
    select 1 from users
    where active is true and lower(trim(name)) = lower(v_name)
  ) then
    raise exception 'DUPLICATE';
  end if;

  select coalesce(max(substring(user_id from 2)::int), 0) into v_max
  from users where user_id ~ '^U[0-9]+$';
  v_id := 'U' || lpad((v_max + 1)::text, 3, '0');

  insert into users (user_id, name, active) values (v_id, v_name, true);

  return json_build_object('user_id', v_id, 'name', v_name);
end;
$$;

-- action: 'out' | 'in', method: 'auto' | 'manual'
create or replace function record_action(
  p_key_id text,
  p_user_id text,
  p_user_name text,
  p_action text,
  p_method text default 'auto',
  p_note text default ''
)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('key_tracker:key:' || p_key_id));

  if not exists (select 1 from keys where key_id = p_key_id) then
    raise exception 'Unknown key_id: %', p_key_id;
  end if;

  -- 1. Log first — source of truth.
  insert into log (timestamp, key_id, user_id, user_name, action, method, note)
  values (now(), p_key_id, p_user_id, p_user_name, p_action, coalesce(p_method, 'auto'), coalesce(p_note, ''));

  -- 2. Then update the cached rollup on keys.
  update keys set
    status = case when p_action = 'out' then 'out' else 'in' end,
    holder = case when p_action = 'out' then p_user_id else null end,
    last_updated = now()
  where key_id = p_key_id;

  return get_key_state(p_key_id);
end;
$$;

-- Two-step log write for the "someone forgot to check in" case: check in
-- the previous holder, then check out the new one, both method 'manual'.
create or replace function record_swap(
  p_key_id text,
  p_from_user_id text,
  p_from_user_name text,
  p_to_user_id text,
  p_to_user_name text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('key_tracker:key:' || p_key_id));

  if not exists (select 1 from keys where key_id = p_key_id) then
    raise exception 'Unknown key_id: %', p_key_id;
  end if;

  insert into log (timestamp, key_id, user_id, user_name, action, method, note)
  values (now(), p_key_id, p_from_user_id, p_from_user_name, 'in', 'manual', 'swap → ' || p_to_user_name);

  insert into log (timestamp, key_id, user_id, user_name, action, method, note)
  values (now(), p_key_id, p_to_user_id, p_to_user_name, 'out', 'manual', 'swap ← ' || p_from_user_name);

  update keys set
    status = 'out',
    holder = p_to_user_id,
    last_updated = now()
  where key_id = p_key_id;

  return get_key_state(p_key_id);
end;
$$;

-- ============================================================================
-- 4. PUBLIC API — board screen
-- ============================================================================

create or replace function get_board()
returns json
language sql
security definer
set search_path = public
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'key_id', b.key_id,
        'name', b.name,
        'location', b.location,
        'status', b.status,
        'holder_name', b.holder_name,
        'last_updated', b.last_updated
      )
      order by (b.status <> 'out'), b.last_updated asc
    ),
    '[]'::json
  )
  from (
    select
      k.key_id, k.name, k.location, coalesce(k.status, 'in') as status,
      case when k.status = 'out' then coalesce(u.name, k.holder, '') else '' end as holder_name,
      k.last_updated
    from keys k
    left join users u on u.user_id = k.holder
    where k.active is true
  ) b;
$$;

-- ============================================================================
-- 5. ADMIN API — every function re-checks the passcode server-side
-- ============================================================================

create or replace function admin_list_keys(p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_check_pass(p_pass);
  return coalesce((
    select json_agg(row_to_json(k) order by k.key_id) from keys k
  ), '[]'::json);
end;
$$;

create or replace function admin_upsert_key(p_key jsonb, p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key_id text := p_key->>'key_id';
  v_exists boolean;
begin
  perform admin_check_pass(p_pass);

  select exists(select 1 from keys where key_id = v_key_id) into v_exists;

  if v_exists then
    update keys set
      name = p_key->>'name',
      location = p_key->>'location',
      active = coalesce((p_key->>'active')::boolean, active)
    where key_id = v_key_id;
  else
    insert into keys (key_id, name, location, status, holder, last_updated, active)
    values (v_key_id, p_key->>'name', p_key->>'location', 'in', null, now(), true);
  end if;

  return admin_list_keys(p_pass);
end;
$$;

create or replace function admin_next_key_id(p_pass text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max int;
begin
  perform admin_check_pass(p_pass);
  select coalesce(max(substring(key_id from 2)::int), 0) into v_max
  from keys where key_id ~ '^K[0-9]+$';
  return 'K' || lpad((v_max + 1)::text, 2, '0');
end;
$$;

create or replace function admin_retire_key(p_key_id text, p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_check_pass(p_pass);
  update keys set active = false where key_id = p_key_id;
  return admin_list_keys(p_pass);
end;
$$;

create or replace function admin_list_users(p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_check_pass(p_pass);
  return coalesce((
    select json_agg(row_to_json(u) order by u.user_id) from users u
  ), '[]'::json);
end;
$$;

create or replace function admin_next_user_id(p_pass text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max int;
begin
  perform admin_check_pass(p_pass);
  select coalesce(max(substring(user_id from 2)::int), 0) into v_max
  from users where user_id ~ '^U[0-9]+$';
  return 'U' || lpad((v_max + 1)::text, 3, '0');
end;
$$;

create or replace function admin_upsert_user(p_user jsonb, p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id text := p_user->>'user_id';
  v_exists boolean;
begin
  perform admin_check_pass(p_pass);

  select exists(select 1 from users where user_id = v_user_id) into v_exists;

  if v_exists then
    update users set
      name = p_user->>'name',
      active = coalesce((p_user->>'active')::boolean, active)
    where user_id = v_user_id;
  else
    insert into users (user_id, name, active)
    values (v_user_id, p_user->>'name', true);
  end if;

  return admin_list_users(p_pass);
end;
$$;

create or replace function admin_deactivate_user(p_user_id text, p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_check_pass(p_pass);
  update users set active = false where user_id = p_user_id;
  return admin_list_users(p_pass);
end;
$$;

create or replace function admin_force_check_in(p_key_id text, p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_check_pass(p_pass);
  return record_action(p_key_id, 'ADMIN', 'Manager', 'in', 'manual', 'forced check-in');
end;
$$;

-- type: 'currently_out' | 'by_teacher' | 'key_history'
create or replace function admin_report(p_type text, p_params jsonb, p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_check_pass(p_pass);

  if p_type = 'currently_out' then
    return coalesce((
      select json_agg(b) from json_array_elements(get_board()) b
      where (b->>'status') = 'out'
    ), '[]'::json);
  end if;

  if p_type = 'by_teacher' then
    return coalesce((
      select json_agg(b) from json_array_elements(get_board()) b
      where (b->>'status') = 'out' and (b->>'holder_name') = (p_params->>'name')
    ), '[]'::json);
  end if;

  if p_type = 'key_history' then
    return coalesce((
      select json_agg(row_to_json(l) order by l."timestamp" desc)
      from (
        select * from log
        where key_id = (p_params->>'key_id')
        order by "timestamp" desc
        limit coalesce((p_params->>'limit')::int, 50)
      ) l
    ), '[]'::json);
  end if;

  return '[]'::json;
end;
$$;

-- Replays the full log to rebuild keys.status / keys.holder from scratch.
-- Run this if the tables were hand-edited into an inconsistent state.
create or replace function admin_rebuild_status(p_pass text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_check_pass(p_pass);

  update keys k set
    status = latest.action,
    holder = case when latest.action = 'out' then latest.user_id else null end,
    last_updated = latest.ts
  from (
    select distinct on (key_id)
      key_id, action, user_id, "timestamp" as ts
    from log
    order by key_id, "timestamp" desc
  ) latest
  where k.key_id = latest.key_id;

  return admin_list_keys(p_pass);
end;
$$;

-- ============================================================================
-- 6. GRANTS
-- ============================================================================
-- Base tables stay locked (no grants beyond RLS default-deny). Only the
-- functions above are callable by the anon (and authenticated) role.

grant usage on schema public to anon, authenticated;

grant execute on function
  get_key_state(text),
  get_users(),
  find_user_by_name(text),
  create_unique_user(text),
  record_action(text, text, text, text, text, text),
  record_swap(text, text, text, text, text),
  get_board(),
  admin_list_keys(text),
  admin_upsert_key(jsonb, text),
  admin_next_key_id(text),
  admin_retire_key(text, text),
  admin_list_users(text),
  admin_next_user_id(text),
  admin_upsert_user(jsonb, text),
  admin_deactivate_user(text, text),
  admin_force_check_in(text, text),
  admin_report(text, jsonb, text),
  admin_rebuild_status(text)
to anon, authenticated;

-- ============================================================================
-- 7. SEED DATA (edit or delete before running in production)
-- ============================================================================
-- Uncomment and adjust to seed a few keys so you can test the scan screen
-- immediately after running this file.
--
-- insert into keys (key_id, name, location) values
--   ('K01', 'מעבדת מדעים', 'קומה 2'),
--   ('K02', 'חדר מוזיקה', 'קומה 1')
-- on conflict (key_id) do nothing;

-- ============================================================================
-- IMPORTANT: change the admin passcode from the placeholder above by running:
--   update admin_config set passcode = 'your-real-passcode-here';
-- ============================================================================
