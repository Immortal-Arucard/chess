-- Chess community schema. Not applied by the Chess site.
-- Run once, as the database owner, in the Supabase project the parent chooses.
-- This file does not read or write Compass tables (profiles, results, test_events).
-- It does not match or backfill accounts by email.
-- The service-role key must stay off the Chess website.
-- There is no trigger on auth.users. Signing in does not join Chess or any other service.
-- chess_private is not part of the Data API. Do not add it to Exposed schemas.

begin;

create schema chess_private;
revoke all on schema chess_private from public, anon, authenticated;

create table public.chess_profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  created_at timestamptz not null default now(),
  -- Public profile id is not the master auth user id.
  -- Email and auth account fields stay in auth.users and are not copied here.
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

revoke all on chess_private.profile_owners from public, anon, authenticated;
revoke all on chess_private.admins from public, anon, authenticated;

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
create index chess_reports_recent on public.chess_reports (created_at desc);

create function chess_private.my_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select profile_id
  from chess_private.profile_owners
  where owner_id = auth.uid()
$$;

create function chess_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from chess_private.admins where owner_id = auth.uid()
  )
$$;

create function chess_private.join_chess(requested_name text)
returns table (id uuid, display_name text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleaned text;
  created_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in before joining Chess.';
  end if;
  cleaned := regexp_replace(coalesce(requested_name, ''), '\s+', ' ', 'g');
  cleaned := btrim(cleaned);
  if char_length(cleaned) < 1 or char_length(cleaned) > 40 or cleaned ~ '[[:cntrl:]]' then
    raise exception 'Enter a display name of 1 to 40 characters.';
  end if;
  if exists (select 1 from chess_private.profile_owners where owner_id = auth.uid()) then
    raise exception 'This login already has a Chess profile.';
  end if;
  insert into public.chess_profiles (display_name)
  values (cleaned)
  returning public.chess_profiles.id into created_id;
  insert into chess_private.profile_owners (profile_id, owner_id)
  values (created_id, auth.uid());
  return query
    select profiles.id, profiles.display_name, profiles.created_at
    from public.chess_profiles profiles
    where profiles.id = created_id;
end;
$$;

create function chess_private.rename_chess(requested_name text)
returns table (id uuid, display_name text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleaned text;
  mine uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in before renaming your Chess profile.';
  end if;
  mine := chess_private.my_profile_id();
  if mine is null then
    raise exception 'Join Chess before renaming a profile.';
  end if;
  cleaned := regexp_replace(coalesce(requested_name, ''), '\s+', ' ', 'g');
  cleaned := btrim(cleaned);
  if char_length(cleaned) < 1 or char_length(cleaned) > 40 or cleaned ~ '[[:cntrl:]]' then
    raise exception 'Enter a display name of 1 to 40 characters.';
  end if;
  update public.chess_profiles
  set display_name = cleaned
  where public.chess_profiles.id = mine;
  return query
    select profiles.id, profiles.display_name, profiles.created_at
    from public.chess_profiles profiles
    where profiles.id = mine;
end;
$$;

create function chess_private.leave_chess()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine uuid;
begin
  mine := chess_private.my_profile_id();
  if mine is null then
    return;
  end if;
  delete from public.chess_profiles where id = mine;
end;
$$;

revoke all on function chess_private.my_profile_id() from public, anon;
revoke all on function chess_private.is_admin() from public, anon;
revoke all on function chess_private.join_chess(text) from public, anon;
revoke all on function chess_private.rename_chess(text) from public, anon;
revoke all on function chess_private.leave_chess() from public, anon;
grant execute on function chess_private.my_profile_id() to authenticated;
grant execute on function chess_private.is_admin() to authenticated;
grant execute on function chess_private.join_chess(text) to authenticated;
grant execute on function chess_private.rename_chess(text) to authenticated;
grant execute on function chess_private.leave_chess() to authenticated;

create function public.chess_my_profile()
returns table (id uuid, display_name text, created_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select profiles.id, profiles.display_name, profiles.created_at
  from public.chess_profiles profiles
  where profiles.id = chess_private.my_profile_id()
$$;

create function public.chess_join(requested_name text)
returns table (id uuid, display_name text, created_at timestamptz)
language sql
volatile
security invoker
set search_path = ''
as $$
  select id, display_name, created_at from chess_private.join_chess(requested_name)
$$;

create function public.chess_rename(requested_name text)
returns table (id uuid, display_name text, created_at timestamptz)
language sql
volatile
security invoker
set search_path = ''
as $$
  select id, display_name, created_at from chess_private.rename_chess(requested_name)
$$;

create function public.chess_leave()
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  perform chess_private.leave_chess();
end;
$$;

revoke all on function public.chess_my_profile() from public, anon;
revoke all on function public.chess_join(text) from public, anon;
revoke all on function public.chess_rename(text) from public, anon;
revoke all on function public.chess_leave() from public, anon;
grant execute on function public.chess_my_profile() to authenticated;
grant execute on function public.chess_join(text) to authenticated;
grant execute on function public.chess_rename(text) to authenticated;
grant execute on function public.chess_leave() to authenticated;

alter table public.chess_profiles enable row level security;
alter table public.chess_posts enable row level security;
alter table public.chess_replies enable row level security;
alter table public.chess_reports enable row level security;
alter table public.chess_profiles force row level security;
alter table public.chess_posts force row level security;
alter table public.chess_replies force row level security;
alter table public.chess_reports force row level security;

create policy chess_profiles_select on public.chess_profiles
  for select to anon, authenticated
  using (true);

create policy chess_posts_select on public.chess_posts
  for select to anon, authenticated
  using (
    hidden_at is null
    or author_id = (select chess_private.my_profile_id())
    or (select chess_private.is_admin())
  );

create policy chess_posts_insert on public.chess_posts
  for insert to authenticated
  with check (
    author_id = (select chess_private.my_profile_id())
    and hidden_at is null
  );

create policy chess_posts_admin_update on public.chess_posts
  for update to authenticated
  using ((select chess_private.is_admin()))
  with check ((select chess_private.is_admin()));

create policy chess_posts_delete on public.chess_posts
  for delete to authenticated
  using (
    author_id = (select chess_private.my_profile_id())
    or (select chess_private.is_admin())
  );

create policy chess_replies_select on public.chess_replies
  for select to anon, authenticated
  using (
    hidden_at is null
    or author_id = (select chess_private.my_profile_id())
    or (select chess_private.is_admin())
  );

create policy chess_replies_insert on public.chess_replies
  for insert to authenticated
  with check (
    author_id = (select chess_private.my_profile_id())
    and hidden_at is null
    and exists (
      select 1 from public.chess_posts posts
      where posts.id = post_id and posts.hidden_at is null
    )
  );

create policy chess_replies_admin_update on public.chess_replies
  for update to authenticated
  using ((select chess_private.is_admin()))
  with check ((select chess_private.is_admin()));

create policy chess_replies_delete on public.chess_replies
  for delete to authenticated
  using (
    author_id = (select chess_private.my_profile_id())
    or (select chess_private.is_admin())
  );

create policy chess_reports_insert on public.chess_reports
  for insert to authenticated
  with check (reporter_id = (select chess_private.my_profile_id()));

create policy chess_reports_select on public.chess_reports
  for select to authenticated
  using (
    reporter_id = (select chess_private.my_profile_id())
    or (select chess_private.is_admin())
  );

grant select (id, display_name, created_at) on public.chess_profiles to anon, authenticated;
grant select on public.chess_posts to anon, authenticated;
grant insert, update, delete on public.chess_posts to authenticated;
grant select on public.chess_replies to anon, authenticated;
grant insert, update, delete on public.chess_replies to authenticated;
grant select, insert on public.chess_reports to authenticated;

grant usage on schema chess_private to service_role;
grant select on chess_private.profile_owners, chess_private.admins to service_role;
grant select, insert, update, delete on
  public.chess_profiles,
  public.chess_posts,
  public.chess_replies,
  public.chess_reports
to service_role;

create function public.chess_enforce_post_rate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  recent integer;
begin
  select count(*) into recent
  from public.chess_posts
  where author_id = new.author_id
    and created_at > now() - interval '10 minutes';
  if recent >= 10 then
    raise exception 'Too many posts. Try again in a few minutes.';
  end if;
  return new;
end;
$$;

create function public.chess_enforce_reply_rate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  recent integer;
begin
  select count(*) into recent
  from public.chess_replies
  where author_id = new.author_id
    and created_at > now() - interval '10 minutes';
  if recent >= 30 then
    raise exception 'Too many replies. Try again in a few minutes.';
  end if;
  return new;
end;
$$;

create trigger chess_posts_rate
  before insert on public.chess_posts
  for each row execute function public.chess_enforce_post_rate();

create trigger chess_replies_rate
  before insert on public.chess_replies
  for each row execute function public.chess_enforce_reply_rate();

revoke all on function public.chess_enforce_post_rate() from public, anon, authenticated;
revoke all on function public.chess_enforce_reply_rate() from public, anon, authenticated;

commit;
