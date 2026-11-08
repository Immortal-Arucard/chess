-- Chess community schema. Not applied by the Chess site.
-- Run once, as the database owner, in the Supabase project the parent chooses.
-- This file does not read or write Compass tables (profiles, results, test_events).
-- It does not match or backfill accounts by email.
-- The service_role key must stay off the Chess website.
-- There is no trigger on auth.users. Signing in does not join Chess or any other service.
-- chess_private is not part of the Data API. Do not add it to Exposed schemas.
-- The Chess browser does not hold the master JWT. chess_api sees only chess.profile_id.
-- chess_server is the future Chess service, used after that service has checked the master login.

begin;

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

commit;
