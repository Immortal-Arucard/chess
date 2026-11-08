-- HTTP entry points for the Chess service. Not applied to production.
-- Privileged functions live in chess_service, which is not an exposed Data API schema.
-- chess_server cannot revoke an arbitrary master account. chess_authority can.

begin;

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
