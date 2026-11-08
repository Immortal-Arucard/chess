#!/bin/sh
set -eu
db="chess_community_test_$$"
cleanup() {
  psql -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists $db;" >/dev/null
}
trap cleanup EXIT
psql -d postgres -v ON_ERROR_STOP=1 -c "create database $db;"
psql -d "$db" -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
insert into auth.users (id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');
SQL
psql -d "$db" -v ON_ERROR_STOP=1 -f supabase/chess_community.sql
psql -d "$db" -v ON_ERROR_STOP=1 <<'SQL'
create temp table ids (name text primary key, id uuid);
grant select on table ids to anon, authenticated, chess_api;
insert into ids (name, id)
select 'ada', provision.id
from chess_private.provision_profile('11111111-1111-4111-8111-111111111111', 'Ada') provision;
insert into ids (name, id)
select 'bob', provision.id
from chess_private.provision_profile('22222222-2222-4222-8222-222222222222', 'Bob') provision;

set role anon;
do $$ begin
  perform chess_private.provision_profile('11111111-1111-4111-8111-111111111111', 'Ada');
  raise exception 'anon provision should fail';
exception when insufficient_privilege then null;
end $$;
reset role;

set role authenticated;
do $$ begin
  perform * from chess_private.profile_owners;
  raise exception 'authenticated read owners should fail';
exception when insufficient_privilege then null;
end $$;
reset role;

select chess_private.open_session('11111111-1111-4111-8111-111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
do $$ begin
  if chess_private.profile_for_token('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    is distinct from (select id from ids where name = 'ada') then
    raise exception 'token resolved the wrong profile';
  end if;
  if chess_private.profile_for_token('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') is not null then
    raise exception 'unknown token resolved a profile';
  end if;
end $$;

set role chess_api;
select set_config('chess.profile_id', (select id::text from ids where name = 'ada'), false);
do $$ begin
  perform * from chess_private.profile_owners;
  raise exception 'chess_api read owners should fail';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform * from chess_private.sessions;
  raise exception 'chess_api read sessions should fail';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform chess_private.open_session('11111111-1111-4111-8111-111111111111', 'cccccccccccccccccccccccccccccccc');
  raise exception 'chess_api should not open sessions';
exception when insufficient_privilege then null;
end $$;
insert into public.chess_posts (author_id, body)
select id, 'Hello from Ada' from ids where name = 'ada';
do $$ begin
  insert into public.chess_posts (author_id, body)
  select id, 'Ada pretending' from ids where name = 'bob';
  raise exception 'cross-profile post should fail';
exception when others then
  if sqlerrm not like '%own Chess profile%' then raise; end if;
end $$;
do $$ begin
  insert into public.chess_posts (author_id, body, created_at)
  select id, 'backdated', timestamptz '2000-01-01' from ids where name = 'ada';
  raise exception 'created_at insert should fail';
exception when insufficient_privilege then null;
end $$;
reset role;

set role chess_api;
select set_config('chess.profile_id', (select id::text from ids where name = 'bob'), false);
insert into public.chess_replies (post_id, author_id, body)
select posts.id, ids.id, 'A reply'
from public.chess_posts posts
join ids on ids.name = 'bob'
where posts.body = 'Hello from Ada';
do $$ begin
  delete from public.chess_posts posts
  using ids
  where posts.author_id = ids.id and ids.name = 'ada';
  if found then raise exception 'Bob deleted Ada post'; end if;
end $$;
reset role;

set role anon;
do $$ begin
  if (select count(*) from public.chess_posts) <> 1 then
    raise exception 'anon should see the visible post';
  end if;
  if (select count(*) from public.chess_replies) <> 1 then
    raise exception 'anon should see the reply on a visible post';
  end if;
  truncate public.chess_posts;
  raise exception 'anon truncate should fail';
exception when insufficient_privilege then null;
end $$;
reset role;

set role chess_api;
select set_config('chess.profile_id', (select id::text from ids where name = 'ada'), false);
update public.chess_posts set hidden_at = now()
where author_id = (select id from ids where name = 'ada');
reset role;
do $$ begin
  if exists (select 1 from public.chess_posts where hidden_at is not null) then
    raise exception 'member hid a post';
  end if;
end $$;

insert into chess_private.admins (owner_id) values ('11111111-1111-4111-8111-111111111111');
set role chess_api;
select set_config('chess.profile_id', (select id::text from ids where name = 'ada'), false);
update public.chess_posts set hidden_at = now()
where author_id = (select id from ids where name = 'ada');
do $$ begin
  update public.chess_posts set body = 'changed'
  where author_id = (select id from ids where name = 'ada');
  raise exception 'admin body edit should fail';
exception when insufficient_privilege then null;
end $$;
reset role;

set role anon;
do $$ begin
  if (select count(*) from public.chess_posts) <> 0 then
    raise exception 'anon saw a hidden post';
  end if;
  if (select count(*) from public.chess_replies) <> 0 then
    raise exception 'anon saw a reply on a hidden post';
  end if;
end $$;
reset role;

set role chess_api;
select set_config('chess.profile_id', (select id::text from ids where name = 'bob'), false);
do $$ begin
  if (select count(*) from public.chess_replies) <> 0 then
    raise exception 'Bob saw a reply on a hidden post';
  end if;
end $$;
reset role;

set role chess_api;
select set_config('chess.profile_id', (select id::text from ids where name = 'ada'), false);
update public.chess_posts set hidden_at = null
where author_id = (select id from ids where name = 'ada');
reset role;

set role chess_api;
select set_config('chess.profile_id', (select id::text from ids where name = 'bob'), false);
do $$ begin
  for i in 1..29 loop
    insert into public.chess_replies (post_id, author_id, body)
    select posts.id, ids.id, 'rate'
    from public.chess_posts posts
    join ids on ids.name = 'bob'
    where posts.body = 'Hello from Ada'
    limit 1;
  end loop;
  begin
    insert into public.chess_replies (post_id, author_id, body)
    select posts.id, ids.id, 'over'
    from public.chess_posts posts
    join ids on ids.name = 'bob'
    where posts.body = 'Hello from Ada'
    limit 1;
    raise exception 'rate limit should fail';
  exception when others then
    if sqlerrm not like '%Too many replies%' then raise; end if;
  end;
end $$;
reset role;

select chess_private.leave_chess('22222222-2222-4222-8222-222222222222');
insert into ids (name, id)
select 'bob2', provision.id
from chess_private.provision_profile('22222222-2222-4222-8222-222222222222', 'Bob') provision;

set role chess_api;
select set_config('chess.profile_id', (select id::text from ids where name = 'bob2'), false);
do $$ begin
  insert into public.chess_replies (post_id, author_id, body)
  select posts.id, ids.id, 'after rejoin'
  from public.chess_posts posts
  join ids on ids.name = 'bob2'
  where posts.body = 'Hello from Ada'
  limit 1;
  raise exception 'rejoin should not reset the rate limit';
exception when others then
  if sqlerrm not like '%Too many replies%' then raise; end if;
end $$;
reset role;

set role chess_api;
select set_config('chess.profile_id', (select id::text from ids where name = 'ada'), false);
insert into public.chess_reports (reporter_id, post_id, reason)
select ids.id, posts.id, 'spam'
from ids
join public.chess_posts posts on posts.body = 'Hello from Ada'
where ids.name = 'ada';
reset role;

set role anon;
do $$ begin
  perform * from public.chess_reports;
  raise exception 'anon reports should fail';
exception when insufficient_privilege then null;
end $$;
reset role;

set role chess_api;
select set_config('chess.profile_id', (select id::text from ids where name = 'bob2'), false);
do $$ begin
  if (select count(*) from public.chess_reports) <> 0 then
    raise exception 'Bob saw Ada report';
  end if;
end $$;
reset role;
SQL
echo "chess community authorization tests passed"
