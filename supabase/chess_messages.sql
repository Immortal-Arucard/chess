-- Direct messages and discussion mentions. Apply once after the other Chess SQL files.
-- This file does not edit an already-applied file. It replaces two functions
-- in place so a discussion message can name the profiles it tags.

begin;

do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null;
end $$;

create table public.chess_direct_threads (
  id uuid primary key default gen_random_uuid(),
  low_id uuid not null references public.chess_profiles (id) on delete cascade,
  high_id uuid not null references public.chess_profiles (id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  constraint chess_direct_ordered check (low_id < high_id),
  constraint chess_direct_pair unique (low_id, high_id)
);

create table public.chess_direct_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chess_direct_threads (id) on delete cascade,
  author_id uuid not null references public.chess_profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint chess_direct_body_len check (char_length(btrim(body)) between 1 and 1000),
  constraint chess_direct_body_chars check (body !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]')
);

create index chess_direct_messages_order on public.chess_direct_messages (thread_id, created_at, id);

create table public.chess_discussion_mentions (
  message_id uuid not null references public.chess_discussion_messages (id) on delete cascade,
  profile_id uuid not null references public.chess_profiles (id) on delete cascade,
  start_at integer not null,
  end_at integer not null,
  token text not null,
  primary key (message_id, profile_id),
  constraint chess_mention_span check (start_at >= 0 and end_at > start_at)
);

create table chess_private.notification_events (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.chess_profiles (id) on delete cascade,
  actor_id uuid references public.chess_profiles (id) on delete set null,
  kind text not null,
  dedupe_key text not null,
  url text not null,
  title text not null,
  body text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (recipient_id, dedupe_key)
);

create index notification_events_recipient on chess_private.notification_events (recipient_id, created_at);

revoke all on table public.chess_direct_threads from public, anon, authenticated, chess_api, chess_server;
revoke all on table public.chess_direct_messages from public, anon, authenticated, chess_api, chess_server;
revoke all on table public.chess_discussion_mentions from public, anon, authenticated, chess_api, chess_server;
revoke all on table chess_private.notification_events from public, anon, authenticated, chess_api, chess_server;
grant select on table public.chess_direct_threads to authenticated;
grant select on table public.chess_direct_messages to authenticated;
grant select on table public.chess_discussion_mentions to anon, authenticated;

alter table public.chess_direct_threads enable row level security;
alter table public.chess_direct_threads force row level security;
alter table public.chess_direct_messages enable row level security;
alter table public.chess_direct_messages force row level security;
alter table public.chess_discussion_mentions enable row level security;
alter table public.chess_discussion_mentions force row level security;

create function chess_private.direct_visible(low_profile uuid, high_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from chess_private.profile_owners owners
    where owners.owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      and owners.profile_id in (low_profile, high_profile)
  )
$$;

revoke all on function chess_private.direct_visible(uuid, uuid) from public;
grant execute on function chess_private.direct_visible(uuid, uuid) to authenticated;

create policy chess_direct_threads_select on public.chess_direct_threads
  for select to authenticated
  using (chess_private.direct_visible(low_id, high_id));

create policy chess_direct_messages_select on public.chess_direct_messages
  for select to authenticated
  using (
    exists (
      select 1 from public.chess_direct_threads threads
      where threads.id = thread_id
        and chess_private.direct_visible(threads.low_id, threads.high_id)
    )
  );

create policy chess_discussion_mentions_select on public.chess_discussion_mentions
  for select to anon, authenticated
  using (true);

create function chess_private.notification_put(
  actor uuid,
  recipient uuid,
  event_kind text,
  event_key text,
  target_url text,
  event_title text,
  event_body text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if actor is null or recipient is null or actor = recipient then
    return;
  end if;
  if event_kind not in (
    'direct_message', 'mention', 'your_turn', 'challenged',
    'game_result', 'challenge_accepted', 'challenge_declined'
  ) then
    return;
  end if;
  if target_url is null or left(target_url, 1) <> '/' or left(target_url, 2) = '//' then
    return;
  end if;
  insert into chess_private.notification_events (recipient_id, actor_id, kind, dedupe_key, url, title, body)
  values (recipient, actor, event_kind, event_key, target_url, left(event_title, 120), left(event_body, 180))
  on conflict (recipient_id, dedupe_key) do nothing;
end;
$$;

create function chess_private.record_mentions(message_id uuid, message_body text, author uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i integer := 1;
  n integer := char_length(message_body);
  start_pos integer;
  token text;
  token_end integer;
  cursor integer;
  found_id uuid;
  found_name text;
  author_name text := 'A Chess member';
  mentions jsonb := '[]'::jsonb;
begin
  select profiles.display_name into author_name from public.chess_profiles profiles where profiles.id = author;
  while i <= n loop
    token := null;
    token_end := null;
    if substring(message_body from i for 1) = '@'
      and (i = 1 or substring(message_body from i - 1 for 1) ~ '[[:space:]]') then
      start_pos := i;
      if i < n and substring(message_body from i + 1 for 1) = '"' then
        cursor := i + 2;
        while cursor <= n and substring(message_body from cursor for 1) <> '"' loop
          cursor := cursor + 1;
        end loop;
        if cursor <= n and cursor > i + 2 and (cursor - i - 2) <= 40 then
          token := substring(message_body from i + 2 for cursor - i - 2);
          token_end := cursor;
        end if;
      else
        cursor := i + 1;
        while cursor <= n and (cursor - i) <= 40
          and substring(message_body from cursor for 1) ~ '[[:alnum:]_''-]' loop
          cursor := cursor + 1;
        end loop;
        if cursor > i + 1 then
          token := substring(message_body from i + 1 for cursor - i - 1);
          token_end := cursor - 1;
        end if;
      end if;
      if token is not null and token !~ '[[:cntrl:]]' then
        begin
          select profiles.id, profiles.display_name into strict found_id, found_name
          from public.chess_profiles profiles
          where lower(profiles.display_name) = lower(token);
        exception
          when no_data_found then found_id := null;
          when too_many_rows then found_id := null;
        end;
        if found_id is not null and not exists (
          select 1 from public.chess_discussion_mentions prior
          where prior.message_id = record_mentions.message_id and prior.profile_id = found_id
        ) then
          insert into public.chess_discussion_mentions (message_id, profile_id, start_at, end_at, token)
          values (
            record_mentions.message_id,
            found_id,
            start_pos - 1,
            token_end,
            substring(message_body from start_pos for token_end - start_pos + 1)
          );
          mentions := mentions || jsonb_build_array(jsonb_build_object(
            'id', found_id,
            'displayName', found_name,
            'start', start_pos - 1,
            'end', token_end,
            'text', substring(message_body from start_pos for token_end - start_pos + 1)
          ));
          if found_id is distinct from author then
            perform chess_private.notification_put(
              author, found_id, 'mention', 'mention:' || record_mentions.message_id::text,
              '/community/discussion/', coalesce(author_name, 'A Chess member'), 'You were mentioned in the Chess discussion.'
            );
          end if;
        end if;
      end if;
      i := case when token_end is not null and token_end >= i then token_end + 1 else i + 1 end;
    else
      i := i + 1;
    end if;
  end loop;
  return mentions;
end;
$$;

create function chess_private.mention_list(message uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', mentions.profile_id,
    'displayName', profiles.display_name,
    'start', mentions.start_at,
    'end', mentions.end_at,
    'text', mentions.token
  ) order by mentions.start_at), '[]'::jsonb)
  from public.chess_discussion_mentions mentions
  join public.chess_profiles profiles on profiles.id = mentions.profile_id
  where mentions.message_id = mention_list.message
$$;

create or replace function chess_service.discussion_page(before_time timestamptz, before_id uuid, after_time timestamptz, after_id uuid, page_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  lim integer := least(greatest(coalesce(page_limit, 30), 1), 50);
begin
  if before_time is not null and after_time is not null then
    raise exception 'The request could not be completed.';
  end if;
  if (before_time is null) <> (before_id is null) or (after_time is null) <> (after_id is null) then
    raise exception 'The request could not be completed.';
  end if;
  if after_time is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', page.id,
      'authorId', page.author_id,
      'authorName', page.display_name,
      'body', page.body,
      'createdAt', page.created_at,
      'mentions', chess_private.mention_list(page.id)
    ) order by page.created_at, page.id), '[]'::jsonb)
    into result
    from (
      select messages.id, messages.author_id, profiles.display_name, messages.body, messages.created_at
      from public.chess_discussion_messages messages
      join public.chess_profiles profiles on profiles.id = messages.author_id
      where (messages.created_at, messages.id) > (after_time, after_id)
      order by messages.created_at asc, messages.id asc
      limit lim
    ) page;
    return result;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'authorId', page.author_id,
    'authorName', page.display_name,
    'body', page.body,
    'createdAt', page.created_at,
    'mentions', chess_private.mention_list(page.id)
  ) order by page.created_at, page.id), '[]'::jsonb)
  into result
  from (
    select messages.id, messages.author_id, profiles.display_name, messages.body, messages.created_at
    from public.chess_discussion_messages messages
    join public.chess_profiles profiles on profiles.id = messages.author_id
    where before_time is null or (messages.created_at, messages.id) < (before_time, before_id)
    order by messages.created_at desc, messages.id desc
    limit lim
  ) page;
  return result;
end;
$$;

create or replace function chess_service.discussion_send(raw_token text, message_body text, expected_author uuid)
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
  mentions jsonb;
begin
  actor := chess_private.as_profile(raw_token);
  if expected_author is distinct from actor then
    raise exception 'You can discuss only as your own Chess profile.';
  end if;
  if char_length(clean) < 1 or char_length(clean) > 1000 or clean ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'A discussion message must be 1 to 1000 characters.';
  end if;
  select owners.owner_id into owner from chess_private.profile_owners owners where owners.profile_id = actor;
  perform chess_private.bump_rate(owner, 'discussion', 40);
  insert into public.chess_discussion_messages (author_id, body, created_at)
  values (actor, clean, clock_timestamp())
  returning * into created;
  mentions := chess_private.record_mentions(created.id, created.body, actor);
  select profiles.display_name into name from public.chess_profiles profiles where profiles.id = actor;
  return jsonb_build_object(
    'id', created.id,
    'authorId', created.author_id,
    'authorName', name,
    'body', created.body,
    'createdAt', created.created_at,
    'mentions', mentions
  );
end;
$$;

create function chess_private.direct_pair(actor uuid, other_profile uuid)
returns public.chess_direct_threads
language plpgsql
security definer
set search_path = ''
as $$
declare
  low_profile uuid;
  high_profile uuid;
  thread public.chess_direct_threads;
begin
  if actor is null or other_profile is null or actor = other_profile then
    raise exception 'Choose another Chess member.';
  end if;
  if not exists (select 1 from public.chess_profiles profiles where profiles.id = other_profile) then
    raise exception 'That profile was not found.';
  end if;
  low_profile := least(actor, other_profile);
  high_profile := greatest(actor, other_profile);
  insert into public.chess_direct_threads (low_id, high_id)
  values (low_profile, high_profile)
  on conflict (low_id, high_id) do nothing;
  select * into thread from public.chess_direct_threads threads
  where threads.low_id = low_profile and threads.high_id = high_profile;
  return thread;
end;
$$;

create function chess_service.direct_open(raw_token text, other_profile uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  thread public.chess_direct_threads;
begin
  actor := chess_private.as_profile(raw_token);
  thread := chess_private.direct_pair(actor, other_profile);
  return chess_service.direct_page(raw_token, thread.id, null, null, 30);
end;
$$;

create function chess_service.direct_send(raw_token text, expected uuid, other_profile uuid, message_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  owner uuid;
  clean text := btrim(coalesce(message_body, ''));
  thread public.chess_direct_threads;
  created public.chess_direct_messages%rowtype;
  other_name text;
  actor_name text;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then
    raise exception 'You can message only as your own Chess profile.';
  end if;
  if char_length(clean) < 1 or char_length(clean) > 1000 or clean ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'A direct message must be 1 to 1000 characters.';
  end if;
  thread := chess_private.direct_pair(actor, other_profile);
  select owners.owner_id into owner from chess_private.profile_owners owners where owners.profile_id = actor;
  perform chess_private.bump_rate(owner, 'direct', 40);
  insert into public.chess_direct_messages (thread_id, author_id, body)
  values (thread.id, actor, clean)
  returning * into created;
  select profiles.display_name into other_name from public.chess_profiles profiles where profiles.id = other_profile;
  select profiles.display_name into actor_name from public.chess_profiles profiles where profiles.id = actor;
  perform chess_private.notification_put(
    actor, other_profile, 'direct_message', 'dm:' || created.id::text,
    '/community/messages/?with=' || actor::text, coalesce(actor_name, 'A Chess member'), clean
  );
  return jsonb_build_object(
    'threadId', thread.id,
    'id', created.id,
    'authorId', created.author_id,
    'body', created.body,
    'createdAt', created.created_at,
    'with', jsonb_build_object('id', other_profile, 'displayName', other_name)
  );
end;
$$;

create function chess_service.direct_page(raw_token text, thread_id uuid, before_time timestamptz, before_id uuid, page_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  thread public.chess_direct_threads;
  lim integer := least(greatest(coalesce(page_limit, 30), 1), 50);
  result jsonb;
  other_profile uuid;
  other_name text;
begin
  actor := chess_private.as_profile(raw_token);
  select * into thread from public.chess_direct_threads threads where threads.id = thread_id;
  if not found or (thread.low_id <> actor and thread.high_id <> actor) then
    raise exception 'That conversation was not found.';
  end if;
  if (before_time is null) <> (before_id is null) then
    raise exception 'The request could not be completed.';
  end if;
  other_profile := case when thread.low_id = actor then thread.high_id else thread.low_id end;
  select profiles.display_name into other_name from public.chess_profiles profiles where profiles.id = other_profile;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'authorId', page.author_id,
    'body', page.body,
    'createdAt', page.created_at
  ) order by page.created_at, page.id), '[]'::jsonb)
  into result
  from (
    select messages.id, messages.author_id, messages.body, messages.created_at
    from public.chess_direct_messages messages
    where messages.thread_id = thread.id
      and (before_time is null or (messages.created_at, messages.id) < (before_time, before_id))
    order by messages.created_at desc, messages.id desc
    limit lim
  ) page;
  return jsonb_build_object(
    'threadId', thread.id,
    'with', jsonb_build_object('id', other_profile, 'displayName', other_name),
    'messages', result
  );
end;
$$;

create function chess_service.direct_inbox(raw_token text)
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
    'threadId', page.id,
    'with', jsonb_build_object('id', page.other_id, 'displayName', page.other_name),
    'body', page.body,
    'createdAt', page.created_at
  ) order by page.created_at desc), '[]'::jsonb)
  into result
  from (
    select threads.id,
      case when threads.low_id = actor then threads.high_id else threads.low_id end as other_id,
      profiles.display_name as other_name,
      latest.body,
      latest.created_at
    from public.chess_direct_threads threads
    join lateral (
      select messages.body, messages.created_at
      from public.chess_direct_messages messages
      where messages.thread_id = threads.id
      order by messages.created_at desc, messages.id desc
      limit 1
    ) latest on true
    join public.chess_profiles profiles
      on profiles.id = case when threads.low_id = actor then threads.high_id else threads.low_id end
    where threads.low_id = actor or threads.high_id = actor
    order by latest.created_at desc
    limit 50
  ) page;
  return result;
end;
$$;

revoke all on function chess_service.direct_open(text, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.direct_send(text, uuid, uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.direct_page(text, uuid, timestamptz, uuid, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.direct_inbox(text) from public, anon, authenticated, chess_api;
grant execute on function chess_service.direct_open(text, uuid) to chess_server;
grant execute on function chess_service.direct_send(text, uuid, uuid, text) to chess_server;
grant execute on function chess_service.direct_page(text, uuid, timestamptz, uuid, integer) to chess_server;
grant execute on function chess_service.direct_inbox(text) to chess_server;

commit;
