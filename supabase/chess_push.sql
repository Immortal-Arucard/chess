-- Web Push subscriptions and game notification events.
-- Apply once after supabase/chess_messages.sql.

begin;

create table chess_private.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.chess_profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_secret text not null,
  created_at timestamptz not null default clock_timestamp()
);

create table chess_private.push_preferences (
  profile_id uuid not null references public.chess_profiles (id) on delete cascade,
  kind text not null,
  enabled boolean not null,
  primary key (profile_id, kind)
);

alter table chess_private.notification_events
  add column if not exists delivered_at timestamptz;

revoke all on table chess_private.push_subscriptions from public, anon, authenticated, chess_api, chess_server;
revoke all on table chess_private.push_preferences from public, anon, authenticated, chess_api, chess_server;

create or replace function chess_private.notification_put(
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
  if recipient is null or (actor is not null and actor = recipient) then
    return;
  end if;
  if event_kind not in (
    'direct_message', 'mention', 'your_turn', 'challenged',
    'game_result', 'challenge_accepted', 'challenge_declined', 'test'
  ) then
    return;
  end if;
  if target_url is null or left(target_url, 1) <> '/' or left(target_url, 2) = '//' then
    return;
  end if;
  insert into chess_private.notification_events (recipient_id, actor_id, kind, dedupe_key, url, title, body)
  values (recipient, actor, event_kind, event_key, target_url, left(coalesce(event_title, 'Chess'), 120), left(coalesce(event_body, ''), 180))
  on conflict (recipient_id, dedupe_key) do nothing;
end;
$$;

create function chess_service.notification_from_game(raw_token text, match_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  match chess_private.human_matches;
  turn text;
  mover uuid;
  actor_name text := 'A Chess member';
  target text;
begin
  actor := chess_private.as_profile(raw_token);
  select * into match from chess_private.human_matches games where games.id = match_id;
  if not found then
    return;
  end if;
  if actor is distinct from match.creator_id
    and actor is distinct from match.white_id
    and actor is distinct from match.black_id
    and actor is distinct from match.challenged_id then
    return;
  end if;
  select profiles.display_name into actor_name from public.chess_profiles profiles where profiles.id = actor;
  target := '/human/?match=' || match.id::text;
  if match.status = 'open' and match.kind = 'named' and match.challenged_id is not null then
    perform chess_private.notification_put(actor, match.challenged_id, 'challenged', 'challenge:' || match.id::text, target, coalesce(actor_name, 'A Chess member'), 'You have a Chess challenge.');
  end if;
  if match.status = 'aborted' and match.termination = 'declined' then
    perform chess_private.notification_put(actor, match.creator_id, 'challenge_declined', 'declined:' || match.id::text, target, coalesce(actor_name, 'A Chess member'), 'Your Chess challenge was declined.');
  end if;
  if match.status = 'active' and match.version = 2 then
    perform chess_private.notification_put(actor, match.creator_id, 'challenge_accepted', 'accepted:' || match.id::text, target, coalesce(actor_name, 'A Chess member'), 'Your Chess challenge was accepted.');
  end if;
  if match.status = 'active' then
    turn := chess_private.human_turn(match);
    mover := case when turn = 'white' then match.white_id else match.black_id end;
    perform chess_private.notification_put(actor, mover, 'your_turn', 'turn:' || match.id::text || ':' || match.version::text, target, 'Your turn', 'It is your turn in a Chess game.');
  end if;
  if match.status = 'finished' then
    perform chess_private.notification_put(actor, match.white_id, 'game_result', 'result:' || match.id::text, target, 'Game over', 'A Chess game you are in has ended.');
    perform chess_private.notification_put(actor, match.black_id, 'game_result', 'result:' || match.id::text, target, 'Game over', 'A Chess game you are in has ended.');
  end if;
end;
$$;

create function chess_service.push_save(raw_token text, expected uuid, next_endpoint text, next_p256dh text, next_auth text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  saved uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then
    raise exception 'You can play only as your own Chess profile.';
  end if;
  if next_endpoint is null or char_length(next_endpoint) < 12 or char_length(next_endpoint) > 2000
    or left(next_endpoint, 8) <> 'https://' and left(next_endpoint, 16) <> 'http://127.0.0.1'
    and left(next_endpoint, 16) <> 'http://localhost' then
    raise exception 'The request could not be completed.';
  end if;
  if next_p256dh is null or next_auth is null or char_length(next_p256dh) > 200 or char_length(next_auth) > 200 then
    raise exception 'The request could not be completed.';
  end if;
  insert into chess_private.push_subscriptions as subscriptions (profile_id, endpoint, p256dh, auth_secret)
  values (actor, next_endpoint, next_p256dh, next_auth)
  on conflict (endpoint) do update set profile_id = excluded.profile_id, p256dh = excluded.p256dh, auth_secret = excluded.auth_secret
  returning subscriptions.id into saved;
  return saved;
end;
$$;

create function chess_service.push_forget(endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from chess_private.push_subscriptions subscriptions where subscriptions.endpoint = push_forget.endpoint;
end;
$$;

create function chess_service.push_drop(raw_token text, endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  delete from chess_private.push_subscriptions subscriptions
  where subscriptions.endpoint = push_drop.endpoint and subscriptions.profile_id = actor;
end;
$$;

create function chess_service.push_preference(raw_token text, expected uuid, event_kind text, enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then
    raise exception 'You can play only as your own Chess profile.';
  end if;
  if event_kind not in (
    'direct_message', 'mention', 'your_turn', 'challenged',
    'game_result', 'challenge_accepted', 'challenge_declined'
  ) then
    raise exception 'The request could not be completed.';
  end if;
  insert into chess_private.push_preferences (profile_id, kind, enabled)
  values (actor, event_kind, coalesce(enabled, true))
  on conflict (profile_id, kind) do update set enabled = excluded.enabled;
  return chess_service.push_settings(raw_token);
end;
$$;

create function chess_service.push_settings(raw_token text)
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
  select coalesce(jsonb_object_agg(kinds.kind, coalesce(prefs.enabled, true)), '{}'::jsonb)
  into result
  from (
    values
      ('direct_message'), ('mention'), ('your_turn'), ('challenged'),
      ('game_result'), ('challenge_accepted'), ('challenge_declined')
  ) as kinds(kind)
  left join chess_private.push_preferences prefs
    on prefs.profile_id = actor and prefs.kind = kinds.kind;
  return result;
end;
$$;

create function chess_service.push_test(raw_token text, expected uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then
    raise exception 'You can play only as your own Chess profile.';
  end if;
  perform chess_private.notification_put(
    null, actor, 'test', 'test:' || extensions.gen_random_uuid()::text,
    '/community/profile/?id=' || actor::text, 'Chess', 'This is a test notification.'
  );
end;
$$;

create function chess_service.push_due()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  update chess_private.notification_events events
  set delivered_at = clock_timestamp()
  where events.delivered_at is null
    and exists (
      select 1 from chess_private.push_preferences prefs
      where prefs.profile_id = events.recipient_id
        and prefs.kind = events.kind
        and prefs.enabled = false
    );
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', events.id,
    'kind', events.kind,
    'title', events.title,
    'body', events.body,
    'url', events.url,
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'endpoint', subscriptions.endpoint,
        'p256dh', subscriptions.p256dh,
        'auth', subscriptions.auth_secret
      ))
      from chess_private.push_subscriptions subscriptions
      where subscriptions.profile_id = events.recipient_id
    ), '[]'::jsonb)
  ) order by events.created_at), '[]'::jsonb)
  into result
  from (
    select * from chess_private.notification_events pending
    where pending.delivered_at is null
    order by pending.created_at
    limit 20
  ) events;
  return result;
end;
$$;

create function chess_service.push_mark(event_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update chess_private.notification_events events
  set delivered_at = clock_timestamp()
  where events.id = event_id;
end;
$$;

revoke all on function chess_service.notification_from_game(text, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.push_save(text, uuid, text, text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.push_forget(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.push_drop(text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.push_preference(text, uuid, text, boolean) from public, anon, authenticated, chess_api;
revoke all on function chess_service.push_settings(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.push_test(text, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.push_due() from public, anon, authenticated, chess_api;
revoke all on function chess_service.push_mark(uuid) from public, anon, authenticated, chess_api;
grant execute on function chess_service.notification_from_game(text, uuid) to chess_server;
grant execute on function chess_service.push_save(text, uuid, text, text, text) to chess_server;
grant execute on function chess_service.push_forget(text) to chess_server;
grant execute on function chess_service.push_drop(text, text) to chess_server;
grant execute on function chess_service.push_preference(text, uuid, text, boolean) to chess_server;
grant execute on function chess_service.push_settings(text) to chess_server;
grant execute on function chess_service.push_test(text, uuid) to chess_server;
grant execute on function chess_service.push_due() to chess_server;
grant execute on function chess_service.push_mark(uuid) to chess_server;

commit;
