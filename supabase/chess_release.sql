-- One transaction. Run this whole file once in the Supabase SQL editor.
-- It contains chess_community.sql, chess_service.sql, and chess_http.sql with their inner commits removed.
begin;
-- Chess community schema. Not applied by the Chess site.
-- Run once, as the database owner, in the Supabase project the parent chooses.
-- This file does not read or write Compass tables (profiles, results, test_events).
-- It does not match or backfill accounts by email.
-- The service_role key must stay off the Chess website.
-- There is no trigger on auth.users. Signing in does not join Chess or any other service.
-- chess_private is not part of the Data API. Do not add it to Exposed schemas.
-- The Chess browser does not hold the master JWT. chess_api sees only chess.profile_id.
-- chess_server is the future Chess service, used after that service has checked the master login.



create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;

do $$ begin
  create role chess_api nologin;
exception when duplicate_object then null;
end $$;

do $$ begin
  create role chess_server nologin;
exception when duplicate_object then null;
end $$;

create schema if not exists chess_private;
revoke all on schema chess_private from public, anon, authenticated;
grant usage on schema chess_private to chess_api, chess_server;

create table public.chess_profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint chess_profiles_display_name_len check (char_length(display_name) between 1 and 40),
  constraint chess_profiles_display_name_text check (display_name !~ '[[:cntrl:]]')
);

create table chess_private.profile_owners (
  profile_id uuid primary key references public.chess_profiles (id) on delete cascade,
  owner_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table chess_private.admins (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table chess_private.sessions (
  token_hash text primary key,
  profile_id uuid not null references public.chess_profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table chess_private.rate_buckets (
  owner_id uuid not null,
  action text not null,
  window_start timestamptz not null,
  hits integer not null check (hits >= 0),
  primary key (owner_id, action, window_start)
);

create table public.chess_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.chess_profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  hidden_at timestamptz,
  constraint chess_posts_body_len check (char_length(btrim(body)) between 1 and 2000),
  constraint chess_posts_body_chars check (body !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]')
);

create table public.chess_replies (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.chess_posts (id) on delete cascade,
  author_id uuid not null references public.chess_profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  hidden_at timestamptz,
  constraint chess_replies_body_len check (char_length(btrim(body)) between 1 and 2000),
  constraint chess_replies_body_chars check (body !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]')
);

create table public.chess_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.chess_profiles (id) on delete cascade,
  post_id uuid references public.chess_posts (id) on delete cascade,
  reply_id uuid references public.chess_replies (id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint chess_reports_one_target check ((post_id is null) <> (reply_id is null)),
  constraint chess_reports_reason_len check (char_length(btrim(reason)) between 1 and 500),
  constraint chess_reports_reason_chars check (reason !~ '[[:cntrl:]]'),
  constraint chess_reports_unique_post unique (reporter_id, post_id),
  constraint chess_reports_unique_reply unique (reporter_id, reply_id)
);

create index chess_posts_feed on public.chess_posts (created_at desc, id desc);
create index chess_posts_by_author on public.chess_posts (author_id, created_at desc, id desc);
create index chess_replies_thread on public.chess_replies (post_id, created_at, id);
create index chess_replies_by_author on public.chess_replies (author_id, created_at, id);
create index chess_reports_recent on public.chess_reports (created_at desc);
create index chess_reports_by_post on public.chess_reports (post_id);
create index chess_reports_by_reply on public.chess_reports (reply_id);

revoke all on table public.chess_profiles from public, anon, authenticated;
revoke all on table public.chess_posts from public, anon, authenticated;
revoke all on table public.chess_replies from public, anon, authenticated;
revoke all on table public.chess_reports from public, anon, authenticated;
revoke all on chess_private.profile_owners from public, anon, authenticated;
revoke all on chess_private.admins from public, anon, authenticated;
revoke all on chess_private.sessions from public, anon, authenticated, chess_api;
revoke all on chess_private.rate_buckets from public, anon, authenticated, chess_api;

alter table public.chess_profiles enable row level security;
alter table public.chess_posts enable row level security;
alter table public.chess_replies enable row level security;
alter table public.chess_reports enable row level security;
alter table chess_private.profile_owners enable row level security;
alter table chess_private.admins enable row level security;
alter table chess_private.sessions enable row level security;
alter table chess_private.rate_buckets enable row level security;
alter table public.chess_profiles force row level security;
alter table public.chess_posts force row level security;
alter table public.chess_replies force row level security;
alter table public.chess_reports force row level security;
alter table chess_private.profile_owners force row level security;
alter table chess_private.admins force row level security;
alter table chess_private.sessions force row level security;
alter table chess_private.rate_buckets force row level security;

create function chess_private.token_hash(raw_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(raw_token, 'utf8'), 'sha256'), 'hex')
$$;

create function chess_private.current_profile_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('chess.profile_id', true), '')::uuid
$$;

create function chess_private.profile_is_admin(profile uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from chess_private.profile_owners owners
    join chess_private.admins admins on admins.owner_id = owners.owner_id
    where owners.profile_id = profile
  )
$$;

create function chess_private.profile_for_token(raw_token text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select sessions.profile_id
  from chess_private.sessions sessions
  where sessions.token_hash = chess_private.token_hash(raw_token)
    and sessions.expires_at > now()
$$;

create function chess_private.bump_rate(rate_owner uuid, rate_action text, max_hits integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  bucket_start timestamptz := to_timestamp(floor(extract(epoch from clock_timestamp()) / 600) * 600);
  total integer;
begin
  insert into chess_private.rate_buckets as buckets (owner_id, action, window_start, hits)
  values (rate_owner, rate_action, bucket_start, 1)
  on conflict (owner_id, action, window_start)
  do update set hits = buckets.hits + 1
  returning hits into total;
  if total > max_hits then
    raise exception using message = format('Too many %s. Try again in a few minutes.', rate_action);
  end if;
end;
$$;

create function chess_private.provision_profile(master_id uuid, requested_name text)
returns table (id uuid, display_name text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleaned text;
  created_id uuid;
begin
  if master_id is null then
    raise exception 'A verified master account is required.';
  end if;
  cleaned := regexp_replace(coalesce(requested_name, ''), '\s+', ' ', 'g');
  cleaned := btrim(cleaned);
  if char_length(cleaned) < 1 or char_length(cleaned) > 40 or cleaned ~ '[[:cntrl:]]' then
    raise exception 'Enter a display name of 1 to 40 characters.';
  end if;
  if exists (select 1 from chess_private.profile_owners where owner_id = master_id) then
    raise exception 'This login already has a Chess profile.';
  end if;
  insert into public.chess_profiles (display_name)
  values (cleaned)
  returning public.chess_profiles.id into created_id;
  insert into chess_private.profile_owners (profile_id, owner_id)
  values (created_id, master_id);
  return query
    select profiles.id, profiles.display_name, profiles.created_at
    from public.chess_profiles profiles
    where profiles.id = created_id;
end;
$$;

create function chess_private.open_session(master_id uuid, raw_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile uuid;
begin
  select owners.profile_id into profile
  from chess_private.profile_owners owners
  where owners.owner_id = master_id;
  if profile is null then
    raise exception 'Join Chess before opening a session.';
  end if;
  if raw_token is null or char_length(raw_token) < 32 then
    raise exception 'Session token is too short.';
  end if;
  insert into chess_private.sessions (token_hash, profile_id, expires_at)
  values (chess_private.token_hash(raw_token), profile, now() + interval '12 hours');
  return profile;
end;
$$;

create function chess_private.leave_chess(master_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine uuid;
begin
  select owners.profile_id into mine
  from chess_private.profile_owners owners
  where owners.owner_id = master_id;
  if mine is null then
    return;
  end if;
  delete from public.chess_profiles where id = mine;
end;
$$;

create function chess_private.prepare_post()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner uuid;
  actor uuid := chess_private.current_profile_id();
begin
  if actor is null or new.author_id is distinct from actor then
    raise exception 'You can post only as your own Chess profile.';
  end if;
  select owners.owner_id into owner
  from chess_private.profile_owners owners
  where owners.profile_id = actor;
  if owner is null then
    raise exception 'This Chess profile has no owner.';
  end if;
  new.created_at := clock_timestamp();
  new.hidden_at := null;
  perform chess_private.bump_rate(owner, 'posts', 10);
  return new;
end;
$$;

create function chess_private.prepare_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner uuid;
  actor uuid := chess_private.current_profile_id();
begin
  if actor is null or new.author_id is distinct from actor then
    raise exception 'You can reply only as your own Chess profile.';
  end if;
  if not exists (
    select 1 from public.chess_posts posts
    where posts.id = new.post_id and posts.hidden_at is null
  ) then
    raise exception 'That post is not available.';
  end if;
  select owners.owner_id into owner
  from chess_private.profile_owners owners
  where owners.profile_id = actor;
  if owner is null then
    raise exception 'This Chess profile has no owner.';
  end if;
  new.created_at := clock_timestamp();
  new.hidden_at := null;
  perform chess_private.bump_rate(owner, 'replies', 30);
  return new;
end;
$$;

create function chess_private.prepare_report()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner uuid;
  actor uuid := chess_private.current_profile_id();
begin
  if actor is null or new.reporter_id is distinct from actor then
    raise exception 'You can report only as your own Chess profile.';
  end if;
  select owners.owner_id into owner
  from chess_private.profile_owners owners
  where owners.profile_id = actor;
  if owner is null then
    raise exception 'This Chess profile has no owner.';
  end if;
  new.created_at := clock_timestamp();
  perform chess_private.bump_rate(owner, 'reports', 20);
  return new;
end;
$$;

create function chess_private.guard_moderation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.author_id is distinct from old.author_id
    or new.body is distinct from old.body
    or new.created_at is distinct from old.created_at then
    raise exception 'Only hidden_at can be updated.';
  end if;
  if not chess_private.profile_is_admin(chess_private.current_profile_id()) then
    raise exception 'Only an admin can hide this.';
  end if;
  return new;
end;
$$;

create trigger chess_posts_prepare
  before insert on public.chess_posts
  for each row execute function chess_private.prepare_post();

create trigger chess_replies_prepare
  before insert on public.chess_replies
  for each row execute function chess_private.prepare_reply();

create trigger chess_reports_prepare
  before insert on public.chess_reports
  for each row execute function chess_private.prepare_report();

create trigger chess_posts_moderate
  before update on public.chess_posts
  for each row execute function chess_private.guard_moderation();

create trigger chess_replies_moderate
  before update on public.chess_replies
  for each row execute function chess_private.guard_moderation();

revoke all on function chess_private.token_hash(text) from public, anon, authenticated;
revoke all on function chess_private.current_profile_id() from public, anon, authenticated;
revoke all on function chess_private.profile_is_admin(uuid) from public, anon, authenticated;
revoke all on function chess_private.profile_for_token(text) from public, anon, authenticated;
revoke all on function chess_private.bump_rate(uuid, text, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_private.provision_profile(uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_private.open_session(uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_private.leave_chess(uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_private.prepare_post() from public, anon, authenticated;
revoke all on function chess_private.prepare_reply() from public, anon, authenticated;
revoke all on function chess_private.prepare_report() from public, anon, authenticated;
revoke all on function chess_private.guard_moderation() from public, anon, authenticated;
grant execute on function chess_private.prepare_post() to chess_api;
grant execute on function chess_private.prepare_reply() to chess_api;
grant execute on function chess_private.prepare_report() to chess_api;
grant execute on function chess_private.guard_moderation() to chess_api;

grant execute on function chess_private.profile_for_token(text) to chess_api, chess_server;
grant execute on function chess_private.profile_is_admin(uuid) to chess_api;
grant execute on function chess_private.current_profile_id() to chess_api;
grant execute on function chess_private.provision_profile(uuid, text) to chess_server;
grant execute on function chess_private.open_session(uuid, text) to chess_server;
grant execute on function chess_private.leave_chess(uuid) to chess_server;

grant select (id, display_name, created_at) on public.chess_profiles to anon, chess_api;
grant select on public.chess_posts to anon, chess_api;
grant select on public.chess_replies to anon, chess_api;
grant insert (author_id, body) on public.chess_posts to chess_api;
grant insert (post_id, author_id, body) on public.chess_replies to chess_api;
grant insert (reporter_id, post_id, reply_id, reason) on public.chess_reports to chess_api;
grant update (hidden_at) on public.chess_posts to chess_api;
grant update (hidden_at) on public.chess_replies to chess_api;
grant delete on public.chess_posts to chess_api;
grant delete on public.chess_replies to chess_api;
grant select on public.chess_reports to chess_api;

create policy chess_profiles_select on public.chess_profiles
  for select to anon, chess_api
  using (true);

create policy chess_posts_visible on public.chess_posts
  for select to anon, chess_api
  using (hidden_at is null);

create policy chess_posts_admin_select on public.chess_posts
  for select to chess_api
  using (chess_private.profile_is_admin(chess_private.current_profile_id()));

create policy chess_posts_insert on public.chess_posts
  for insert to chess_api
  with check (author_id = chess_private.current_profile_id());

create policy chess_posts_update on public.chess_posts
  for update to chess_api
  using (chess_private.profile_is_admin(chess_private.current_profile_id()))
  with check (chess_private.profile_is_admin(chess_private.current_profile_id()));

create policy chess_posts_delete on public.chess_posts
  for delete to chess_api
  using (
    author_id = chess_private.current_profile_id()
    or chess_private.profile_is_admin(chess_private.current_profile_id())
  );

create policy chess_replies_visible on public.chess_replies
  for select to anon, chess_api
  using (
    hidden_at is null
    and exists (
      select 1 from public.chess_posts posts
      where posts.id = post_id and posts.hidden_at is null
    )
  );

create policy chess_replies_admin_select on public.chess_replies
  for select to chess_api
  using (chess_private.profile_is_admin(chess_private.current_profile_id()));

create policy chess_replies_insert on public.chess_replies
  for insert to chess_api
  with check (author_id = chess_private.current_profile_id());

create policy chess_replies_update on public.chess_replies
  for update to chess_api
  using (chess_private.profile_is_admin(chess_private.current_profile_id()))
  with check (chess_private.profile_is_admin(chess_private.current_profile_id()));

create policy chess_replies_delete on public.chess_replies
  for delete to chess_api
  using (
    author_id = chess_private.current_profile_id()
    or chess_private.profile_is_admin(chess_private.current_profile_id())
  );

create policy chess_reports_insert on public.chess_reports
  for insert to chess_api
  with check (reporter_id = chess_private.current_profile_id());

create policy chess_reports_select on public.chess_reports
  for select to chess_api
  using (
    reporter_id = chess_private.current_profile_id()
    or chess_private.profile_is_admin(chess_private.current_profile_id())
  );



-- Chess account service functions. Not applied to production.
-- The browser never calls these. The Chess service connects as chess_server.
-- chess.profile_id is set inside these functions from the opaque session token.
-- A caller cannot pass a profile id or a master id to the public game and community functions.



create table chess_private.browser_sessions (
  token_hash text primary key,
  csrf_hash text not null,
  master_id uuid not null references auth.users (id) on delete cascade,
  profile_id uuid references public.chess_profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  revoked_at timestamptz
);

create table chess_private.suspensions (
  master_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table chess_private.auth_transactions (
  state_hash text primary key,
  verifier text not null,
  code_challenge text not null,
  audience text not null,
  redirect_uri text not null,
  login_hint text,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table chess_private.auth_codes (
  handoff_hash text primary key,
  code text not null,
  state_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table chess_private.account_settings (
  profile_id uuid primary key references public.chess_profiles (id) on delete cascade,
  auto_save_bot_results boolean not null default false
);

create table chess_private.bot_games (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.chess_profiles (id) on delete cascade,
  client_game_id uuid not null,
  pgn text not null,
  start_fen text not null,
  moves jsonb not null,
  result text not null,
  termination text not null,
  player_color text not null,
  opponent_name text not null,
  opponent_uci_elo integer not null,
  rated boolean not null default false,
  piece_style text not null,
  piece_color text not null,
  palette text not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  unique (profile_id, client_game_id),
  constraint bot_games_rated_false check (rated = false),
  constraint bot_games_result check (result in ('1-0', '0-1', '1/2-1/2')),
  constraint bot_games_color check (player_color in ('white', 'black'))
);

create index bot_games_by_profile on chess_private.bot_games (profile_id, created_at desc);

revoke all on chess_private.browser_sessions from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.suspensions from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.auth_transactions from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.auth_codes from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.account_settings from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.bot_games from public, anon, authenticated, chess_api, chess_server;

alter table chess_private.browser_sessions enable row level security;
alter table chess_private.suspensions enable row level security;
alter table chess_private.auth_transactions enable row level security;
alter table chess_private.auth_codes enable row level security;
alter table chess_private.account_settings enable row level security;
alter table chess_private.bot_games enable row level security;
alter table chess_private.browser_sessions force row level security;
alter table chess_private.suspensions force row level security;
alter table chess_private.auth_transactions force row level security;
alter table chess_private.auth_codes force row level security;
alter table chess_private.account_settings force row level security;
alter table chess_private.bot_games force row level security;

grant update (display_name) on public.chess_profiles to chess_api;

create policy chess_profiles_rename on public.chess_profiles
  for update to chess_api
  using (id = chess_private.current_profile_id())
  with check (id = chess_private.current_profile_id());

create function chess_private.load_session(raw_token text)
returns table (master_id uuid, profile_id uuid, csrf_hash text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row chess_private.browser_sessions%rowtype;
begin
  select * into session_row
  from chess_private.browser_sessions sessions
  where sessions.token_hash = chess_private.token_hash(raw_token)
    and sessions.revoked_at is null
    and sessions.expires_at > clock_timestamp()
    and sessions.idle_expires_at > clock_timestamp();
  if not found then
    return;
  end if;
  if exists (select 1 from chess_private.suspensions suspended where suspended.master_id = session_row.master_id) then
    update chess_private.browser_sessions sessions
      set revoked_at = clock_timestamp()
      where sessions.token_hash = session_row.token_hash;
    return;
  end if;
  update chess_private.browser_sessions sessions
    set idle_expires_at = clock_timestamp() + interval '30 minutes'
    where sessions.token_hash = session_row.token_hash;
  master_id := session_row.master_id;
  profile_id := session_row.profile_id;
  csrf_hash := session_row.csrf_hash;
  return next;
end;
$$;

create function chess_private.as_profile(raw_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  select sessions.profile_id into actor from chess_private.load_session(raw_token) sessions;
  if actor is null then
    raise exception 'Join Chess before doing that.';
  end if;
  perform set_config('chess.profile_id', actor::text, true);
  return actor;
end;
$$;

create function public.chess_finish_material(handoff text)
returns table (code text, verifier text, audience text, redirect_uri text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  code_row chess_private.auth_codes%rowtype;
  auth chess_private.auth_transactions%rowtype;
begin
  select * into code_row
  from chess_private.auth_codes codes
  where codes.handoff_hash = chess_private.token_hash(handoff)
    and codes.consumed_at is null
    and codes.expires_at > clock_timestamp();
  if not found then
    return;
  end if;
  select * into auth
  from chess_private.auth_transactions transactions
  where transactions.state_hash = code_row.state_hash
    and transactions.consumed_at is null
    and transactions.expires_at > clock_timestamp();
  if not found then
    return;
  end if;
  update chess_private.auth_codes codes set consumed_at = clock_timestamp() where codes.handoff_hash = code_row.handoff_hash;
  update chess_private.auth_transactions transactions set consumed_at = clock_timestamp() where transactions.state_hash = auth.state_hash;
  code := code_row.code;
  verifier := auth.verifier;
  audience := auth.audience;
  redirect_uri := auth.redirect_uri;
  return next;
end;
$$;

create function public.chess_begin_auth(state text, verifier text, challenge text, audience text, redirect_uri text, login_hint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if state is null or char_length(state) < 32 or verifier is null or char_length(verifier) < 32 then
    raise exception 'Sign-in could not start.';
  end if;
  if audience is distinct from 'chess' or redirect_uri is null then
    raise exception 'Sign-in could not start.';
  end if;
  perform chess_private.bump_rate('00000000-0000-4000-8000-000000000001', 'auth-starts', 30);
  insert into chess_private.auth_transactions (state_hash, verifier, code_challenge, audience, redirect_uri, login_hint, expires_at)
  values (chess_private.token_hash(state), verifier, challenge, audience, redirect_uri, login_hint, clock_timestamp() + interval '10 minutes');
end;
$$;

create function public.chess_take_auth(state text)
returns table (verifier text, code_challenge text, audience text, redirect_uri text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_row chess_private.auth_transactions%rowtype;
begin
  select * into auth_row
  from chess_private.auth_transactions transactions
  where transactions.state_hash = chess_private.token_hash(state)
    and transactions.consumed_at is null
    and transactions.expires_at > clock_timestamp();
  if not found then
    return;
  end if;
  update chess_private.auth_transactions transactions
    set consumed_at = clock_timestamp()
    where transactions.state_hash = auth_row.state_hash;
  verifier := auth_row.verifier;
  code_challenge := auth_row.code_challenge;
  audience := auth_row.audience;
  redirect_uri := auth_row.redirect_uri;
  return next;
end;
$$;

create function public.chess_keep_code(state text, code text, handoff text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if code is null or handoff is null or char_length(handoff) < 32 then
    raise exception 'Sign-in could not continue.';
  end if;
  insert into chess_private.auth_codes (handoff_hash, code, state_hash, expires_at)
  values (chess_private.token_hash(handoff), code, chess_private.token_hash(state), clock_timestamp() + interval '5 minutes');
end;
$$;

create function public.chess_take_code(handoff text)
returns table (code text, state_hash text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  code_row chess_private.auth_codes%rowtype;
begin
  select * into code_row
  from chess_private.auth_codes codes
  where codes.handoff_hash = chess_private.token_hash(handoff)
    and codes.consumed_at is null
    and codes.expires_at > clock_timestamp();
  if not found then
    return;
  end if;
  update chess_private.auth_codes codes
    set consumed_at = clock_timestamp()
    where codes.handoff_hash = code_row.handoff_hash;
  code := code_row.code;
  state_hash := code_row.state_hash;
  return next;
end;
$$;

create function public.chess_accept_login(master_id uuid, raw_token text, raw_csrf text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
begin
  if master_id is null or raw_token is null or char_length(raw_token) < 32 or raw_csrf is null or char_length(raw_csrf) < 32 then
    raise exception 'Sign-in could not be completed.';
  end if;
  if not exists (select 1 from auth.users users where users.id = master_id) then
    raise exception 'Sign-in could not be completed.';
  end if;
  if exists (select 1 from chess_private.suspensions suspended where suspended.master_id = chess_accept_login.master_id) then
    raise exception 'This account is suspended.';
  end if;
  perform chess_private.bump_rate(master_id, 'sign-ins', 20);
  select owners.profile_id into existing from chess_private.profile_owners owners where owners.owner_id = master_id;
  insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at)
  values (
    chess_private.token_hash(raw_token),
    chess_private.token_hash(raw_csrf),
    master_id,
    existing,
    clock_timestamp() + interval '12 hours',
    clock_timestamp() + interval '30 minutes'
  );
end;
$$;

create function public.chess_session(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  name text;
  created timestamptz;
begin
  select sessions.profile_id into actor from chess_private.load_session(raw_token) sessions;
  if not found then
    return jsonb_build_object('authenticated', false, 'profile', null);
  end if;
  if actor is not null then
    select profiles.display_name, profiles.created_at into name, created
    from public.chess_profiles profiles where profiles.id = actor;
  end if;
  return jsonb_build_object(
    'authenticated', true,
    'profile', case when actor is null then null else jsonb_build_object('id', actor, 'displayName', name, 'createdAt', created) end
  );
end;
$$;

create function public.chess_csrf_hash(raw_token text)
returns text
language sql
security definer
set search_path = ''
as $$
  select sessions.csrf_hash from chess_private.load_session(raw_token) sessions
$$;

create function public.chess_join(raw_token text, requested_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  master uuid;
  created record;
begin
  select sessions.master_id into master from chess_private.load_session(raw_token) sessions;
  if master is null then
    raise exception 'Sign in before joining Chess.';
  end if;
  perform chess_private.bump_rate(master, 'joins', 5);
  select * into created from chess_private.provision_profile(master, requested_name);
  update chess_private.browser_sessions sessions
    set profile_id = created.id
    where sessions.token_hash = chess_private.token_hash(raw_token);
  insert into chess_private.account_settings (profile_id, auto_save_bot_results) values (created.id, false);
  return jsonb_build_object('id', created.id, 'displayName', created.display_name, 'createdAt', created.created_at);
end;
$$;

create function public.chess_rename(raw_token text, requested_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  cleaned text;
begin
  actor := chess_private.as_profile(raw_token);
  cleaned := btrim(regexp_replace(coalesce(requested_name, ''), '\s+', ' ', 'g'));
  if char_length(cleaned) < 1 or char_length(cleaned) > 40 or cleaned ~ '[[:cntrl:]]' then
    raise exception 'Enter a display name of 1 to 40 characters.';
  end if;
  update public.chess_profiles profiles set display_name = cleaned where profiles.id = actor;
  return jsonb_build_object('id', actor, 'displayName', cleaned);
end;
$$;

create function public.chess_logout(raw_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update chess_private.browser_sessions sessions
    set revoked_at = clock_timestamp()
    where sessions.token_hash = chess_private.token_hash(raw_token);
end;
$$;

create function public.chess_rotate(raw_token text, next_token text, next_csrf text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row chess_private.browser_sessions%rowtype;
begin
  select * into session_row from chess_private.browser_sessions sessions
  where sessions.token_hash = chess_private.token_hash(raw_token) and sessions.revoked_at is null;
  if not found then
    raise exception 'Sign in again.';
  end if;
  update chess_private.browser_sessions sessions set revoked_at = clock_timestamp()
  where sessions.token_hash = session_row.token_hash;
  insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at)
  values (chess_private.token_hash(next_token), chess_private.token_hash(next_csrf), session_row.master_id, session_row.profile_id, session_row.expires_at, clock_timestamp() + interval '30 minutes');
end;
$$;

create function public.chess_revoke_master(master uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into chess_private.suspensions (master_id) values (master)
  on conflict (master_id) do nothing;
  update chess_private.browser_sessions sessions
    set revoked_at = clock_timestamp()
    where sessions.master_id = master and sessions.revoked_at is null;
end;
$$;

create function public.chess_cleanup()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from chess_private.browser_sessions sessions
  where sessions.expires_at < clock_timestamp()
    or sessions.idle_expires_at < clock_timestamp()
    or (sessions.revoked_at is not null and sessions.revoked_at < clock_timestamp() - interval '1 day');
  delete from chess_private.auth_transactions transactions
  where transactions.expires_at < clock_timestamp() or transactions.consumed_at is not null;
  delete from chess_private.auth_codes codes
  where codes.expires_at < clock_timestamp() or codes.consumed_at is not null;
  delete from chess_private.rate_buckets buckets
  where buckets.window_start < clock_timestamp() - interval '1 day';
end;
$$;

create function public.chess_posts(raw_token text, before_time timestamptz, before_id uuid, page_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  actor uuid;
begin
  if raw_token is not null then
    select sessions.profile_id into actor from chess_private.load_session(raw_token) sessions;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', posts.id,
    'authorId', posts.author_id,
    'authorName', profiles.display_name,
    'body', posts.body,
    'createdAt', posts.created_at
  ) order by posts.created_at desc, posts.id desc), '[]'::jsonb)
  into result
  from (
    select * from public.chess_posts posts
    where (posts.hidden_at is null or (actor is not null and chess_private.profile_is_admin(actor)))
      and (before_time is null or (posts.created_at, posts.id) < (before_time, before_id))
    order by posts.created_at desc, posts.id desc
    limit least(coalesce(page_limit, 20), 20)
  ) posts
  join public.chess_profiles profiles on profiles.id = posts.author_id;
  return result;
end;
$$;

create function public.chess_create_post(raw_token text, post_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  created uuid;
begin
  actor := chess_private.as_profile(raw_token);
  insert into public.chess_posts (author_id, body) values (actor, post_body) returning id into created;
  return jsonb_build_object('id', created);
end;
$$;

create function public.chess_delete_post(raw_token text, post_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  removed uuid;
begin
  actor := chess_private.as_profile(raw_token);
  delete from public.chess_posts posts where posts.id = post_id and posts.author_id = actor returning posts.id into removed;
  if removed is null then
    raise exception 'You can delete only your own post.';
  end if;
  return jsonb_build_object('deleted', true, 'id', removed);
end;
$$;

create function public.chess_replies(raw_token text, parent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  actor uuid;
begin
  if raw_token is not null then
    select sessions.profile_id into actor from chess_private.load_session(raw_token) sessions;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', replies.id,
    'postId', replies.post_id,
    'authorId', replies.author_id,
    'authorName', profiles.display_name,
    'body', replies.body,
    'createdAt', replies.created_at
  ) order by replies.created_at, replies.id), '[]'::jsonb)
  into result
  from public.chess_replies replies
  join public.chess_profiles profiles on profiles.id = replies.author_id
  where replies.post_id = parent_id
    and (
      (
        replies.hidden_at is null
        and exists (
          select 1 from public.chess_posts posts
          where posts.id = replies.post_id and posts.hidden_at is null
        )
      )
      or (actor is not null and chess_private.profile_is_admin(actor))
    );
  return result;
end;
$$;

create function public.chess_create_reply(raw_token text, parent_id uuid, reply_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  created uuid;
begin
  actor := chess_private.as_profile(raw_token);
  insert into public.chess_replies (post_id, author_id, body) values (parent_id, actor, reply_body) returning id into created;
  return jsonb_build_object('id', created);
end;
$$;

create function public.chess_delete_reply(raw_token text, reply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  removed uuid;
begin
  actor := chess_private.as_profile(raw_token);
  delete from public.chess_replies replies where replies.id = reply_id and replies.author_id = actor returning replies.id into removed;
  if removed is null then
    raise exception 'You can delete only your own reply.';
  end if;
  return jsonb_build_object('deleted', true, 'id', removed);
end;
$$;

create function public.chess_report(raw_token text, parent_post uuid, parent_reply uuid, report_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  created uuid;
begin
  actor := chess_private.as_profile(raw_token);
  perform set_config('chess.profile_id', actor::text, true);
  insert into public.chess_reports (reporter_id, post_id, reply_id, reason)
  values (actor, parent_post, parent_reply, report_reason)
  returning id into created;
  return jsonb_build_object('id', created);
end;
$$;

create function public.chess_hide_post(raw_token text, post_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if not chess_private.profile_is_admin(actor) then
    raise exception 'Only an admin can hide this.';
  end if;
  update public.chess_posts posts set hidden_at = clock_timestamp() where posts.id = post_id;
  if not found then
    raise exception 'Only an admin can hide this.';
  end if;
  return jsonb_build_object('hidden', true, 'id', post_id);
end;
$$;

create function public.chess_settings(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  enabled boolean;
begin
  actor := chess_private.as_profile(raw_token);
  select settings.auto_save_bot_results into enabled
  from chess_private.account_settings settings where settings.profile_id = actor;
  return jsonb_build_object('autoSaveBotResults', coalesce(enabled, false));
end;
$$;

create function public.chess_settings_set(raw_token text, enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  insert into chess_private.account_settings (profile_id, auto_save_bot_results)
  values (actor, coalesce(enabled, false))
  on conflict (profile_id) do update set auto_save_bot_results = excluded.auto_save_bot_results;
  return jsonb_build_object('autoSaveBotResults', coalesce(enabled, false));
end;
$$;

create function public.chess_save_game(raw_token text, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  existing chess_private.bot_games%rowtype;
  created uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if coalesce(payload->>'rated', 'false') <> 'false' then
    raise exception 'Chess does not store a rated result.';
  end if;
  if jsonb_typeof(payload->'moves') <> 'array' or jsonb_array_length(payload->'moves') < 1 then
    raise exception 'A saved game must include every move.';
  end if;
  if coalesce(payload->>'pgn', '') = '' or coalesce(payload->>'startFen', '') = '' then
    raise exception 'A saved game must include the PGN and the starting position.';
  end if;
  select * into existing from chess_private.bot_games games
  where games.profile_id = actor and games.client_game_id = (payload->>'clientGameId')::uuid;
  if found then
    if existing.pgn = payload->>'pgn' and existing.result = payload->>'result' then
      return jsonb_build_object('status', 'saved', 'id', existing.id, 'duplicate', true);
    end if;
    raise exception 'This game was already saved with different moves.';
  end if;
  insert into chess_private.bot_games (
    profile_id, client_game_id, pgn, start_fen, moves, result, termination, player_color,
    opponent_name, opponent_uci_elo, rated, piece_style, piece_color, palette
  ) values (
    actor,
    (payload->>'clientGameId')::uuid,
    payload->>'pgn',
    payload->>'startFen',
    payload->'moves',
    payload->>'result',
    payload->>'termination',
    payload->>'playerColor',
    payload->>'opponentName',
    (payload->>'opponentUciElo')::integer,
    false,
    payload->>'pieceStyle',
    payload->>'pieceColor',
    payload->>'palette'
  ) returning id into created;
  return jsonb_build_object('status', 'saved', 'id', created, 'duplicate', false);
end;
$$;

create function public.chess_games(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  result jsonb;
begin
  actor := chess_private.as_profile(raw_token);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', games.id,
    'clientGameId', games.client_game_id,
    'pgn', games.pgn,
    'startFen', games.start_fen,
    'moves', games.moves,
    'result', games.result,
    'termination', games.termination,
    'playerColor', games.player_color,
    'opponentName', games.opponent_name,
    'opponentUciElo', games.opponent_uci_elo,
    'rated', games.rated,
    'pieceStyle', games.piece_style,
    'pieceColor', games.piece_color,
    'palette', games.palette,
    'revision', games.revision,
    'createdAt', games.created_at
  ) order by games.created_at desc), '[]'::jsonb)
  into result
  from chess_private.bot_games games
  where games.profile_id = actor;
  return result;
end;
$$;

revoke all on function chess_private.load_session(text) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.as_profile(text) from public, anon, authenticated, chess_api, chess_server;
revoke all on function public.chess_finish_material(text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_begin_auth(text, text, text, text, text, text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_take_auth(text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_keep_code(text, text, text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_take_code(text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_accept_login(uuid, text, text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_session(text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_csrf_hash(text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_join(text, text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_rename(text, text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_logout(text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_rotate(text, text, text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_revoke_master(uuid) from public, anon, authenticated, chess_api;
revoke all on function public.chess_cleanup() from public, anon, authenticated, chess_api;
revoke all on function public.chess_posts(text, timestamptz, uuid, integer) from public, anon, authenticated, chess_api;
revoke all on function public.chess_create_post(text, text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_delete_post(text, uuid) from public, anon, authenticated, chess_api;
revoke all on function public.chess_replies(text, uuid) from public, anon, authenticated, chess_api;
revoke all on function public.chess_create_reply(text, uuid, text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_delete_reply(text, uuid) from public, anon, authenticated, chess_api;
revoke all on function public.chess_report(text, uuid, uuid, text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_hide_post(text, uuid) from public, anon, authenticated, chess_api;
revoke all on function public.chess_settings(text) from public, anon, authenticated, chess_api;
revoke all on function public.chess_settings_set(text, boolean) from public, anon, authenticated, chess_api;
revoke all on function public.chess_save_game(text, jsonb) from public, anon, authenticated, chess_api;
revoke all on function public.chess_games(text) from public, anon, authenticated, chess_api;

grant execute on function public.chess_finish_material(text) to chess_server;
grant execute on function public.chess_begin_auth(text, text, text, text, text, text) to chess_server;
grant execute on function public.chess_take_auth(text) to chess_server;
grant execute on function public.chess_keep_code(text, text, text) to chess_server;
grant execute on function public.chess_take_code(text) to chess_server;
grant execute on function public.chess_accept_login(uuid, text, text) to chess_server;
grant execute on function public.chess_session(text) to chess_server;
grant execute on function public.chess_csrf_hash(text) to chess_server;
grant execute on function public.chess_join(text, text) to chess_server;
grant execute on function public.chess_rename(text, text) to chess_server;
grant execute on function public.chess_logout(text) to chess_server;
grant execute on function public.chess_rotate(text, text, text) to chess_server;
grant execute on function public.chess_revoke_master(uuid) to chess_server;
grant execute on function public.chess_cleanup() to chess_server;
grant execute on function public.chess_posts(text, timestamptz, uuid, integer) to chess_server;
grant execute on function public.chess_create_post(text, text) to chess_server;
grant execute on function public.chess_delete_post(text, uuid) to chess_server;
grant execute on function public.chess_replies(text, uuid) to chess_server;
grant execute on function public.chess_create_reply(text, uuid, text) to chess_server;
grant execute on function public.chess_delete_reply(text, uuid) to chess_server;
grant execute on function public.chess_report(text, uuid, uuid, text) to chess_server;
grant execute on function public.chess_hide_post(text, uuid) to chess_server;
grant execute on function public.chess_settings(text) to chess_server;
grant execute on function public.chess_settings_set(text, boolean) to chess_server;
grant execute on function public.chess_save_game(text, jsonb) to chess_server;
grant execute on function public.chess_games(text) to chess_server;

revoke all on function chess_private.provision_profile(uuid, text) from chess_server;
revoke all on function chess_private.open_session(uuid, text) from chess_server;
revoke all on function chess_private.leave_chess(uuid) from chess_server;



-- HTTP entry points for the Chess service. Not applied to production.
-- Privileged functions live in chess_service, which is not an exposed Data API schema.
-- chess_server cannot revoke an arbitrary master account. chess_authority can.



create schema if not exists chess_service;
revoke all on schema chess_service from public, anon, authenticated;
grant usage on schema chess_service to chess_server;

do $$ begin
  create role chess_authority nologin;
exception when duplicate_object then null;
end $$;
grant usage on schema chess_service to chess_authority;

alter table chess_private.bot_games add column if not exists payload_hash text;

create function chess_service.consume_auth(state text)
returns table (verifier text, redirect_uri text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_row chess_private.auth_transactions%rowtype;
begin
  select * into auth_row
  from chess_private.auth_transactions transactions
  where transactions.state_hash = chess_private.token_hash(state)
  for update;
  if not found or auth_row.consumed_at is not null or auth_row.expires_at <= clock_timestamp() then
    return;
  end if;
  update chess_private.auth_transactions transactions
    set consumed_at = clock_timestamp()
    where transactions.state_hash = auth_row.state_hash
      and transactions.consumed_at is null;
  if not found then
    return;
  end if;
  verifier := auth_row.verifier;
  redirect_uri := auth_row.redirect_uri;
  return next;
end;
$$;

create function chess_service.begin_sign_in(email text, state text, verifier text, challenge text, redirect_uri text, client_ip text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  identity uuid := md5('identity:' || lower(btrim(coalesce(email, ''))))::uuid;
  address uuid := md5('ip:' || coalesce(client_ip, ''))::uuid;
  global_bucket uuid := '00000000-0000-4000-8000-0000000000aa';
begin
  if state is null or char_length(state) < 32 or verifier is null or char_length(verifier) < 32 then
    raise exception 'Sign-in could not start.';
  end if;
  if redirect_uri is null or email is null or position('@' in email) = 0 then
    raise exception 'Sign-in could not start.';
  end if;
  perform chess_private.bump_rate(address, 'auth-ip', 8);
  perform chess_private.bump_rate(identity, 'auth-identity', 5);
  perform chess_private.bump_rate(global_bucket, 'auth-global', 200);
  insert into chess_private.auth_transactions (state_hash, verifier, code_challenge, audience, redirect_uri, login_hint, expires_at)
  values (chess_private.token_hash(state), verifier, challenge, 'provider', redirect_uri, null, clock_timestamp() + interval '10 minutes');
end;
$$;

create function chess_service.complete_login(master_id uuid, raw_token text, raw_csrf text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
begin
  if master_id is null or raw_token is null or char_length(raw_token) < 32 or raw_csrf is null or char_length(raw_csrf) < 32 then
    raise exception 'Sign-in could not be completed.';
  end if;
  if not exists (select 1 from auth.users users where users.id = master_id) then
    raise exception 'Sign-in could not be completed.';
  end if;
  if exists (select 1 from chess_private.suspensions suspended where suspended.master_id = complete_login.master_id) then
    raise exception 'This account is suspended.';
  end if;
  perform chess_private.bump_rate(master_id, 'sign-ins', 20);
  update chess_private.browser_sessions sessions
    set revoked_at = clock_timestamp()
    where sessions.master_id = complete_login.master_id and sessions.revoked_at is null;
  select owners.profile_id into existing from chess_private.profile_owners owners where owners.owner_id = master_id;
  insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at)
  values (
    chess_private.token_hash(raw_token),
    chess_private.token_hash(raw_csrf),
    master_id,
    existing,
    clock_timestamp() + interval '12 hours',
    clock_timestamp() + interval '30 minutes'
  );
end;
$$;

create function chess_service.revoke_master(master uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select public.chess_revoke_master(master)
$$;

create function chess_service.cleanup()
returns void
language sql
security definer
set search_path = ''
as $$
  select public.chess_cleanup()
$$;

create function chess_service.profile(profile uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', profiles.id, 'displayName', profiles.display_name, 'createdAt', profiles.created_at)
  from public.chess_profiles profiles
  where profiles.id = profile
$$;

create function chess_service.posts(raw_token text, author uuid, before_time timestamptz, before_id uuid, page_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  actor uuid;
  admin boolean := false;
begin
  if raw_token is not null then
    select sessions.profile_id into actor from chess_private.load_session(raw_token) sessions;
    admin := actor is not null and chess_private.profile_is_admin(actor);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', posts.id,
    'authorId', posts.author_id,
    'authorName', profiles.display_name,
    'body', posts.body,
    'createdAt', posts.created_at
  ) order by posts.created_at desc, posts.id desc), '[]'::jsonb)
  into result
  from (
    select * from public.chess_posts posts
    where (author is null or posts.author_id = author)
      and (posts.hidden_at is null or admin)
      and (before_time is null or (posts.created_at, posts.id) < (before_time, before_id))
    order by posts.created_at desc, posts.id desc
    limit least(greatest(coalesce(page_limit, 20), 1), 20)
  ) posts
  join public.chess_profiles profiles on profiles.id = posts.author_id;
  return result;
end;
$$;

create function chess_service.save_game(raw_token text, payload jsonb, game_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  existing chess_private.bot_games%rowtype;
  created uuid;
  game_id uuid := (payload->>'clientGameId')::uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if (payload->>'expectedProfileId') is null or (payload->>'expectedProfileId')::uuid is distinct from actor then
    raise exception 'This game belongs to a different Chess account.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('saves:' || actor::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(actor::text || ':' || game_id::text, 0));
  if coalesce(payload->>'rated', 'false') <> 'false' or game_hash is null or char_length(game_hash) <> 64 then
    raise exception 'Chess does not store a rated result.';
  end if;
  if jsonb_typeof(payload->'moves') <> 'array' or jsonb_array_length(payload->'moves') > 400 then
    raise exception 'A saved game must include every move.';
  end if;
  if jsonb_array_length(payload->'moves') = 0 and payload->>'termination' is distinct from 'resign' then
    raise exception 'A saved game must include every move.';
  end if;
  select * into existing from chess_private.bot_games games
  where games.profile_id = actor and games.client_game_id = game_id
  for update;
  if found then
    if existing.payload_hash = game_hash then
      return jsonb_build_object('status', 'saved', 'id', existing.id, 'duplicate', true);
    end if;
    raise exception 'This game was already saved with different moves.';
  end if;
  perform chess_private.bump_rate(actor, 'saves', 30);
  if (select count(*) from chess_private.bot_games games where games.profile_id = actor) >= 20 then
    raise exception 'This account has reached the saved-game limit.';
  end if;
  insert into chess_private.bot_games (
    profile_id, client_game_id, pgn, start_fen, moves, result, termination, player_color,
    opponent_name, opponent_uci_elo, rated, piece_style, piece_color, palette, payload_hash
  ) values (
    actor, game_id, payload->>'pgn', payload->>'startFen', payload->'moves', payload->>'result',
    payload->>'termination', payload->>'playerColor', payload->>'opponentName',
    (payload->>'opponentUciElo')::integer, false, payload->>'pieceStyle', payload->>'pieceColor',
    payload->>'palette', game_hash
  ) returning id into created;
  return jsonb_build_object('status', 'saved', 'id', created, 'duplicate', false);
end;
$$;

revoke all on function chess_service.consume_auth(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.begin_sign_in(text, text, text, text, text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.complete_login(uuid, text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.revoke_master(uuid) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_service.cleanup() from public, anon, authenticated, chess_api;
revoke all on function chess_service.profile(uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.posts(text, uuid, timestamptz, uuid, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.save_game(text, jsonb, text) from public, anon, authenticated, chess_api;

grant execute on function chess_service.consume_auth(text) to chess_server;
grant execute on function chess_service.begin_sign_in(text, text, text, text, text, text) to chess_server;
grant execute on function chess_service.complete_login(uuid, text, text) to chess_server;
grant execute on function chess_service.cleanup() to chess_server;
grant execute on function chess_service.profile(uuid) to chess_server;
grant execute on function chess_service.posts(text, uuid, timestamptz, uuid, integer) to chess_server;
grant execute on function chess_service.save_game(text, jsonb, text) to chess_server;
grant execute on function chess_service.revoke_master(uuid) to chess_authority;

revoke all on function public.chess_accept_login(uuid, text, text) from chess_server;
revoke all on function public.chess_revoke_master(uuid) from chess_server;
drop function if exists public.chess_rotate(text, text, text);

drop function if exists chess_service.revoke_master(uuid);
drop function if exists chess_service.cleanup();
alter function public.chess_revoke_master(uuid) set schema chess_service;
alter function public.chess_cleanup() set schema chess_service;
alter function public.chess_session(text) set schema chess_service;
alter function public.chess_csrf_hash(text) set schema chess_service;
alter function public.chess_join(text, text) set schema chess_service;
alter function public.chess_rename(text, text) set schema chess_service;
alter function public.chess_logout(text) set schema chess_service;
alter function public.chess_create_post(text, text) set schema chess_service;
alter function public.chess_delete_post(text, uuid) set schema chess_service;
alter function public.chess_create_reply(text, uuid, text) set schema chess_service;
alter function public.chess_delete_reply(text, uuid) set schema chess_service;
alter function public.chess_report(text, uuid, uuid, text) set schema chess_service;
alter function public.chess_hide_post(text, uuid) set schema chess_service;
alter function public.chess_settings(text) set schema chess_service;
alter function public.chess_settings_set(text, boolean) set schema chess_service;
alter function public.chess_games(text) set schema chess_service;
alter function public.chess_replies(text, uuid) set schema chess_service;
alter function public.chess_posts(text, timestamptz, uuid, integer) set schema chess_service;

drop function if exists public.chess_finish_material(text);
drop function if exists public.chess_begin_auth(text, text, text, text, text, text);
drop function if exists public.chess_take_auth(text);
drop function if exists public.chess_keep_code(text, text, text);
drop function if exists public.chess_take_code(text);
drop function if exists public.chess_accept_login(uuid, text, text);
drop function if exists public.chess_save_game(text, jsonb);

create function chess_service.reply_page(raw_token text, parent_id uuid, after_time timestamptz, after_id uuid, page_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  actor uuid;
  admin boolean := false;
begin
  if raw_token is not null then
    select sessions.profile_id into actor from chess_private.load_session(raw_token) sessions;
    admin := actor is not null and chess_private.profile_is_admin(actor);
  end if;
  select coalesce(jsonb_agg(row_json), '[]'::jsonb) into result
  from (
    select jsonb_build_object(
      'id', replies.id,
      'postId', replies.post_id,
      'authorId', replies.author_id,
      'authorName', profiles.display_name,
      'body', replies.body,
      'createdAt', replies.created_at
    ) as row_json
    from public.chess_replies replies
    join public.chess_profiles profiles on profiles.id = replies.author_id
    where replies.post_id = parent_id
      and (
        (replies.hidden_at is null and exists (
          select 1 from public.chess_posts posts
          where posts.id = replies.post_id and posts.hidden_at is null
        ))
        or admin
      )
      and (after_time is null or (replies.created_at, replies.id) > (after_time, after_id))
    order by replies.created_at, replies.id
    limit least(greatest(coalesce(page_limit, 20), 1), 20)
  ) page;
  return result;
end;
$$;

create function chess_service.game_page(raw_token text, before_time timestamptz, before_id uuid, page_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  result jsonb;
begin
  actor := chess_private.as_profile(raw_token);
  select coalesce(jsonb_agg(row_json), '[]'::jsonb) into result
  from (
    select jsonb_build_object(
      'id', games.id,
      'clientGameId', games.client_game_id,
      'pgn', games.pgn,
      'startFen', games.start_fen,
      'moves', games.moves,
      'result', games.result,
      'termination', games.termination,
      'playerColor', games.player_color,
      'opponentName', games.opponent_name,
      'opponentUciElo', games.opponent_uci_elo,
      'rated', games.rated,
      'pieceStyle', games.piece_style,
      'pieceColor', games.piece_color,
      'palette', games.palette,
      'revision', games.revision,
      'createdAt', games.created_at
    ) as row_json
    from chess_private.bot_games games
    where games.profile_id = actor
      and (before_time is null or (games.created_at, games.id) < (before_time, before_id))
    order by games.created_at desc, games.id desc
    limit least(greatest(coalesce(page_limit, 20), 1), 20)
  ) page;
  return result;
end;
$$;

revoke all on function chess_service.reply_page(text, uuid, timestamptz, uuid, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.game_page(text, timestamptz, uuid, integer) from public, anon, authenticated, chess_api;
grant execute on function chess_service.reply_page(text, uuid, timestamptz, uuid, integer) to chess_server;
grant execute on function chess_service.game_page(text, timestamptz, uuid, integer) to chess_server;
revoke all on function chess_service.chess_replies(text, uuid) from chess_server;
revoke all on function chess_service.chess_games(text) from chess_server;

revoke all on function chess_service.chess_revoke_master(uuid) from public, anon, authenticated, chess_api, chess_server;
grant execute on function chess_service.chess_revoke_master(uuid) to chess_authority;
grant execute on function chess_service.chess_cleanup() to chess_server;
grant execute on function chess_service.chess_session(text) to chess_server;
grant execute on function chess_service.chess_csrf_hash(text) to chess_server;
grant execute on function chess_service.chess_join(text, text) to chess_server;
grant execute on function chess_service.chess_rename(text, text) to chess_server;
grant execute on function chess_service.chess_logout(text) to chess_server;
grant execute on function chess_service.chess_create_post(text, text) to chess_server;
grant execute on function chess_service.chess_delete_post(text, uuid) to chess_server;
grant execute on function chess_service.chess_create_reply(text, uuid, text) to chess_server;
grant execute on function chess_service.chess_delete_reply(text, uuid) to chess_server;
grant execute on function chess_service.chess_report(text, uuid, uuid, text) to chess_server;
grant execute on function chess_service.chess_hide_post(text, uuid) to chess_server;
grant execute on function chess_service.chess_settings(text) to chess_server;
grant execute on function chess_service.chess_settings_set(text, boolean) to chess_server;
grant execute on function chess_service.chess_posts(text, timestamptz, uuid, integer) to chess_server;



commit;
