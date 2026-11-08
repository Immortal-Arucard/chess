-- Chess community schema. Not applied by the Chess site.
-- Run once, as the database owner, in the Supabase project the parent chooses.
-- This file does not read or write Compass tables (profiles, results, test_events).
-- The service-role key must stay off the Chess website.

begin;

create table public.chess_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint chess_profiles_display_name_len check (char_length(display_name) between 1 and 40),
  constraint chess_profiles_display_name_text check (display_name !~ '[[:cntrl:]]')
);

create table public.chess_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
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
create index chess_replies_thread on public.chess_replies (post_id, created_at, id);
create index chess_reports_recent on public.chess_reports (created_at desc);

alter table public.chess_profiles enable row level security;
alter table public.chess_admins enable row level security;
alter table public.chess_posts enable row level security;
alter table public.chess_replies enable row level security;
alter table public.chess_reports enable row level security;

alter table public.chess_profiles force row level security;
alter table public.chess_admins force row level security;
alter table public.chess_posts force row level security;
alter table public.chess_replies force row level security;
alter table public.chess_reports force row level security;

create policy chess_profiles_select on public.chess_profiles
  for select to anon, authenticated
  using (true);

create policy chess_profiles_insert on public.chess_profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

create policy chess_profiles_update on public.chess_profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy chess_profiles_delete on public.chess_profiles
  for delete to authenticated
  using (id = (select auth.uid()));

create policy chess_admins_select_self on public.chess_admins
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy chess_posts_select on public.chess_posts
  for select to anon, authenticated
  using (
    hidden_at is null
    or author_id = (select auth.uid())
    or exists (
      select 1 from public.chess_admins admins
      where admins.user_id = (select auth.uid())
    )
  );

create policy chess_posts_insert on public.chess_posts
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and hidden_at is null
    and exists (
      select 1 from public.chess_profiles profiles
      where profiles.id = (select auth.uid())
    )
  );

create policy chess_posts_admin_update on public.chess_posts
  for update to authenticated
  using (
    exists (
      select 1 from public.chess_admins admins
      where admins.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.chess_admins admins
      where admins.user_id = (select auth.uid())
    )
  );

create policy chess_posts_delete on public.chess_posts
  for delete to authenticated
  using (
    author_id = (select auth.uid())
    or exists (
      select 1 from public.chess_admins admins
      where admins.user_id = (select auth.uid())
    )
  );

create policy chess_replies_select on public.chess_replies
  for select to anon, authenticated
  using (
    hidden_at is null
    or author_id = (select auth.uid())
    or exists (
      select 1 from public.chess_admins admins
      where admins.user_id = (select auth.uid())
    )
  );

create policy chess_replies_insert on public.chess_replies
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and hidden_at is null
    and exists (
      select 1 from public.chess_profiles profiles
      where profiles.id = (select auth.uid())
    )
    and exists (
      select 1 from public.chess_posts posts
      where posts.id = post_id and posts.hidden_at is null
    )
  );

create policy chess_replies_admin_update on public.chess_replies
  for update to authenticated
  using (
    exists (
      select 1 from public.chess_admins admins
      where admins.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.chess_admins admins
      where admins.user_id = (select auth.uid())
    )
  );

create policy chess_replies_delete on public.chess_replies
  for delete to authenticated
  using (
    author_id = (select auth.uid())
    or exists (
      select 1 from public.chess_admins admins
      where admins.user_id = (select auth.uid())
    )
  );

create policy chess_reports_insert on public.chess_reports
  for insert to authenticated
  with check (reporter_id = (select auth.uid()));

create policy chess_reports_select on public.chess_reports
  for select to authenticated
  using (
    reporter_id = (select auth.uid())
    or exists (
      select 1 from public.chess_admins admins
      where admins.user_id = (select auth.uid())
    )
  );

grant select on public.chess_profiles to anon, authenticated;
grant insert, update, delete on public.chess_profiles to authenticated;

grant select on public.chess_posts to anon, authenticated;
grant insert, update, delete on public.chess_posts to authenticated;

grant select on public.chess_replies to anon, authenticated;
grant insert, update, delete on public.chess_replies to authenticated;

grant select, insert on public.chess_reports to authenticated;
grant select on public.chess_admins to authenticated;

grant select, insert, update, delete on
  public.chess_profiles,
  public.chess_admins,
  public.chess_posts,
  public.chess_replies,
  public.chess_reports
to service_role;

create function public.chess_enforce_post_rate()
returns trigger
language plpgsql
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
