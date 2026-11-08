-- Incremental discussion room. Apply once after chess_release.sql. Do not reapply that release.
begin;

create table public.chess_discussion_messages (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.chess_profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint chess_discussion_body_len check (char_length(btrim(body)) between 1 and 1000),
  constraint chess_discussion_body_chars check (body !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]')
);

create index chess_discussion_order on public.chess_discussion_messages (created_at, id);

revoke all on table public.chess_discussion_messages from public, anon, authenticated, chess_api, chess_server;
grant select on table public.chess_discussion_messages to anon, authenticated;
alter table public.chess_discussion_messages enable row level security;

create policy chess_discussion_select on public.chess_discussion_messages
  for select to anon, authenticated
  using (true);

create function chess_service.discussion_page(before_time timestamptz, before_id uuid, after_time timestamptz, after_id uuid, page_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if before_time is not null and after_time is not null then
    raise exception 'The request could not be completed.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'authorId', page.author_id,
    'authorName', page.display_name,
    'body', page.body,
    'createdAt', page.created_at
  ) order by page.created_at, page.id), '[]'::jsonb)
  into result
  from (
    select messages.id, messages.author_id, profiles.display_name, messages.body, messages.created_at
    from public.chess_discussion_messages messages
    join public.chess_profiles profiles on profiles.id = messages.author_id
    where (before_time is null or (messages.created_at, messages.id) < (before_time, before_id))
      and (after_time is null or (messages.created_at, messages.id) > (after_time, after_id))
    order by messages.created_at desc, messages.id desc
    limit least(greatest(coalesce(page_limit, 30), 1), 50)
  ) page;
  return result;
end;
$$;

create function chess_service.discussion_send(raw_token text, message_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  owner uuid;
  clean text := btrim(coalesce(message_body, ''));
  created public.chess_discussion_messages%rowtype;
  name text;
begin
  actor := chess_private.as_profile(raw_token);
  if char_length(clean) < 1 or char_length(clean) > 1000 or clean ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'A discussion message must be 1 to 1000 characters.';
  end if;
  select owners.owner_id into owner from chess_private.profile_owners owners where owners.profile_id = actor;
  perform chess_private.bump_rate(owner, 'discussion', 40);
  insert into public.chess_discussion_messages (author_id, body, created_at)
  values (actor, clean, clock_timestamp())
  returning * into created;
  select profiles.display_name into name from public.chess_profiles profiles where profiles.id = actor;
  return jsonb_build_object(
    'id', created.id,
    'authorId', created.author_id,
    'authorName', name,
    'body', created.body,
    'createdAt', created.created_at
  );
end;
$$;

revoke all on function chess_service.discussion_page(timestamptz, uuid, timestamptz, uuid, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.discussion_send(text, text) from public, anon, authenticated, chess_api;
grant execute on function chess_service.discussion_page(timestamptz, uuid, timestamptz, uuid, integer) to chess_server;
grant execute on function chess_service.discussion_send(text, text) to chess_server;

commit;
