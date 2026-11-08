-- Chess account service functions. Not applied to production.
-- The browser never calls these. The Chess service connects as chess_server.
-- chess.profile_id is set inside these functions from the opaque session token.
-- A caller cannot pass a profile id or a master id to the public game and community functions.

begin;

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

commit;
