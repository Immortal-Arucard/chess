-- Human games. Apply once after chess_profile_card.sql. Do not reapply earlier migrations.
begin;

alter table chess_private.account_settings
  add column if not exists auto_record_human_chat boolean not null default false;

create table if not exists chess_private.human_matches (
  id uuid primary key default gen_random_uuid(),
  invite text not null unique,
  kind text not null,
  category text not null,
  time_label text not null,
  creator_id uuid not null references public.chess_profiles (id),
  creator_color text not null,
  white_id uuid references public.chess_profiles (id),
  black_id uuid references public.chess_profiles (id),
  challenged_id uuid references public.chess_profiles (id),
  status text not null default 'open',
  start_fen text not null,
  sans jsonb not null default '[]'::jsonb,
  result text,
  termination text,
  draw_offer text,
  base_ms integer,
  increment_ms integer not null default 0,
  white_ms integer,
  black_ms integer,
  clock_at timestamptz,
  daily_days integer,
  deadline_at timestamptz,
  finished_at timestamptz,
  creator_record boolean not null default false,
  opponent_record boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint human_matches_kind check (kind in ('named', 'public')),
  constraint human_matches_category check (category in ('bullet', 'blitz', 'rapid', 'daily', 'untimed')),
  constraint human_matches_color check (creator_color in ('white', 'black', 'random')),
  constraint human_matches_status check (status in ('open', 'active', 'finished', 'aborted')),
  constraint human_matches_result check (result is null or result in ('1-0', '0-1', '1/2-1/2')),
  constraint human_matches_draw check (draw_offer is null or draw_offer in ('white', 'black')),
  constraint human_matches_days check (daily_days is null or daily_days between 1 and 14),
  constraint human_matches_named check (kind = 'public' or challenged_id is not null)
);

create table if not exists chess_private.human_messages (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references chess_private.human_matches (id) on delete cascade,
  author_id uuid not null references public.chess_profiles (id),
  body text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint human_messages_len check (char_length(body) between 1 and 500),
  constraint human_messages_chars check (body !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]')
);

create table if not exists chess_private.human_results (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.chess_profiles (id) on delete cascade,
  client_game_id uuid not null,
  match_id uuid,
  opponent_id uuid,
  opponent_name text not null,
  player_color text not null,
  pgn text not null,
  start_fen text not null,
  moves jsonb not null,
  sans jsonb not null default '[]'::jsonb,
  result text not null,
  termination text not null,
  category text not null,
  time_label text not null,
  piece_style text not null,
  piece_color text not null,
  palette text not null,
  kind text not null,
  dialogue jsonb,
  dialogue_recorded boolean not null default false,
  payload_hash text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  unique (profile_id, client_game_id),
  constraint human_results_color check (player_color in ('white', 'black')),
  constraint human_results_result check (result in ('1-0', '0-1', '1/2-1/2')),
  constraint human_results_kind check (kind in ('pass', 'online')),
  constraint human_results_category check (category in ('bullet', 'blitz', 'rapid', 'daily', 'untimed'))
);

create index if not exists human_matches_open on chess_private.human_matches (status, created_at desc);
create index if not exists human_matches_player on chess_private.human_matches (white_id, black_id, status);
create index if not exists human_messages_match on chess_private.human_messages (match_id, created_at);
create index if not exists human_results_profile on chess_private.human_results (profile_id, created_at desc);

revoke all on chess_private.human_matches from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.human_messages from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.human_results from public, anon, authenticated, chess_api, chess_server;
alter table chess_private.human_matches enable row level security;
alter table chess_private.human_messages enable row level security;
alter table chess_private.human_results enable row level security;
alter table chess_private.human_matches force row level security;
alter table chess_private.human_messages force row level security;
alter table chess_private.human_results force row level security;

create or replace function chess_service.chess_settings(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  enabled boolean;
  record_chat boolean;
begin
  actor := chess_private.as_profile(raw_token);
  select settings.auto_save_bot_results, settings.auto_record_human_chat
    into enabled, record_chat
  from chess_private.account_settings settings where settings.profile_id = actor;
  return jsonb_build_object(
    'autoSaveBotResults', coalesce(enabled, false),
    'autoRecordHumanChat', coalesce(record_chat, false)
  );
end;
$$;

create or replace function chess_service.human_record_setting_set(raw_token text, enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  insert into chess_private.account_settings (profile_id, auto_save_bot_results, auto_record_human_chat)
  values (actor, false, coalesce(enabled, false))
  on conflict (profile_id) do update set auto_record_human_chat = excluded.auto_record_human_chat;
  return chess_service.chess_settings(raw_token);
end;
$$;

create or replace function chess_private.human_turn(match chess_private.human_matches)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_array_length(match.sans) % 2 = 0 then 'white' else 'black' end
$$;

create or replace function chess_private.human_project(match chess_private.human_matches, actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  white_name text;
  black_name text;
  creator_name text;
  challenged_name text;
  my_color text := '';
  recording boolean := false;
begin
  select display_name into white_name from public.chess_profiles where id = match.white_id;
  select display_name into black_name from public.chess_profiles where id = match.black_id;
  select display_name into creator_name from public.chess_profiles where id = match.creator_id;
  select display_name into challenged_name from public.chess_profiles where id = match.challenged_id;
  if actor = match.white_id then my_color := 'white'; elsif actor = match.black_id then my_color := 'black'; end if;
  if actor = match.creator_id then recording := match.creator_record;
  elsif actor is not null and actor is distinct from match.creator_id and (actor = match.white_id or actor = match.black_id) then
    recording := match.opponent_record;
  end if;
  return jsonb_build_object(
    'id', match.id,
    'kind', match.kind,
    'category', match.category,
    'timeLabel', match.time_label,
    'status', match.status,
    'version', match.version,
    'creatorId', match.creator_id,
    'creatorName', creator_name,
    'creatorColor', match.creator_color,
    'whiteId', match.white_id,
    'blackId', match.black_id,
    'whiteName', white_name,
    'blackName', black_name,
    'challengedId', match.challenged_id,
    'challengedName', challenged_name,
    'myColor', nullif(my_color, ''),
    'turn', case when match.status = 'active' then chess_private.human_turn(match) else null end,
    'sans', match.sans,
    'result', match.result,
    'termination', match.termination,
    'drawOffer', match.draw_offer,
    'baseMs', match.base_ms,
    'incrementMs', match.increment_ms,
    'whiteMs', match.white_ms,
    'blackMs', match.black_ms,
    'clockAt', match.clock_at,
    'dailyDays', match.daily_days,
    'deadlineAt', match.deadline_at,
    'finishedAt', match.finished_at,
    'rated', false,
    'iAmRecording', recording,
    'invite', case when actor = match.creator_id then match.invite else null end,
    'serverNow', clock_timestamp(),
    'createdAt', match.created_at
  );
end;
$$;

create or replace function chess_private.human_movetext(sans jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  text_out text := '';
  index integer := 0;
  san text;
begin
  for san in select value from jsonb_array_elements_text(sans) loop
    index := index + 1;
    if index % 2 = 1 then
      text_out := text_out || ((index + 1) / 2)::text || '. ' || san;
    else
      text_out := text_out || ' ' || san || ' ';
    end if;
  end loop;
  return btrim(text_out);
end;
$$;

create or replace function chess_private.human_store_result(match chess_private.human_matches, dialogue jsonb, recorded boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  white_name text;
  black_name text;
  moves jsonb;
  pgn text;
  body text;
begin
  if match.white_id is null or match.black_id is null or match.result is null then
    return;
  end if;
  select display_name into white_name from public.chess_profiles where id = match.white_id;
  select display_name into black_name from public.chess_profiles where id = match.black_id;
  select coalesce(jsonb_agg(jsonb_build_object('ply', ord::integer, 'san', san) order by ord), '[]'::jsonb)
    into moves
  from jsonb_array_elements_text(match.sans) with ordinality as item(san, ord);
  body := chess_private.human_movetext(match.sans);
  pgn := '[Event "Human chess"]' || chr(10) ||
    '[Site "Chess"]' || chr(10) ||
    '[White "' || replace(coalesce(white_name, 'White'), '"', '') || '"]' || chr(10) ||
    '[Black "' || replace(coalesce(black_name, 'Black'), '"', '') || '"]' || chr(10) ||
    '[Result "' || match.result || '"]' || chr(10) ||
    '[TimeControl "' || match.category || ' ' || match.time_label || '"]' || chr(10) ||
    chr(10) || body || ' ' || match.result;
  insert into chess_private.human_results (
    profile_id, client_game_id, match_id, opponent_id, opponent_name, player_color, pgn, start_fen,
    moves, sans, result, termination, category, time_label, piece_style, piece_color, palette, kind,
    dialogue, dialogue_recorded
  ) values
    (match.white_id, match.id, match.id, match.black_id, coalesce(black_name, 'Black'), 'white', pgn, match.start_fen,
      moves, match.sans, match.result, coalesce(match.termination, ''), match.category, match.time_label,
      'standard', 'ink', 'midnight', 'online', case when match.creator_id = match.white_id and recorded and match.creator_record then dialogue when match.creator_id <> match.white_id and recorded and match.opponent_record then dialogue else null end,
      case when match.creator_id = match.white_id then match.creator_record else match.opponent_record end),
    (match.black_id, match.id, match.id, match.white_id, coalesce(white_name, 'White'), 'black', pgn, match.start_fen,
      moves, match.sans, match.result, coalesce(match.termination, ''), match.category, match.time_label,
      'standard', 'ink', 'midnight', 'online', case when match.creator_id = match.black_id and recorded and match.creator_record then dialogue when match.creator_id <> match.black_id and recorded and match.opponent_record then dialogue else null end,
      case when match.creator_id = match.black_id then match.creator_record else match.opponent_record end)
  on conflict (profile_id, client_game_id) do update set
    result = excluded.result,
    termination = excluded.termination,
    moves = excluded.moves,
    sans = excluded.sans,
    pgn = excluded.pgn,
    dialogue = coalesce(chess_private.human_results.dialogue, excluded.dialogue),
    dialogue_recorded = chess_private.human_results.dialogue_recorded or excluded.dialogue_recorded;
end;
$$;

create or replace function chess_private.human_dialogue(match_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', messages.id,
    'authorId', messages.author_id,
    'authorName', profiles.display_name,
    'body', messages.body,
    'createdAt', messages.created_at
  ) order by messages.created_at, messages.id), '[]'::jsonb)
  from chess_private.human_messages messages
  join public.chess_profiles profiles on profiles.id = messages.author_id
  where messages.match_id = human_dialogue.match_id
$$;

create or replace function chess_private.human_finish(match_id uuid, next_result text, next_termination text)
returns chess_private.human_matches
language plpgsql
security definer
set search_path = ''
as $$
declare
  match chess_private.human_matches;
  transcript jsonb;
begin
  update chess_private.human_matches games
    set status = 'finished',
        result = next_result,
        termination = next_termination,
        draw_offer = null,
        finished_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        version = games.version + 1
    where games.id = match_id and games.status = 'active'
    returning * into match;
  if not found then
    select * into match from chess_private.human_matches games where games.id = match_id;
    return match;
  end if;
  transcript := chess_private.human_dialogue(match.id);
  perform chess_private.human_store_result(match, transcript, true);
  return match;
end;
$$;

create or replace function chess_service.human_expire()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  match chess_private.human_matches;
  elapsed integer;
  remaining integer;
  side text;
begin
  for match in
    select * from chess_private.human_matches games
    where games.status = 'active'
    for update skip locked
  loop
    side := chess_private.human_turn(match);
    if match.daily_days is not null and match.deadline_at is not null and match.deadline_at <= clock_timestamp() then
      perform chess_private.human_finish(match.id, case when side = 'white' then '0-1' else '1-0' end, 'timeout');
    elsif match.base_ms is not null and match.clock_at is not null then
      elapsed := greatest(0, floor(extract(epoch from (clock_timestamp() - match.clock_at)) * 1000))::integer;
      remaining := case when side = 'white' then match.white_ms else match.black_ms end - elapsed;
      if remaining < 0 then
        perform chess_private.human_finish(match.id, case when side = 'white' then '0-1' else '1-0' end, 'timeout');
      end if;
    end if;
  end loop;
  delete from chess_private.human_messages messages
  using chess_private.human_matches games
  where messages.match_id = games.id
    and games.finished_at is not null
    and games.finished_at < clock_timestamp() - interval '24 hours';
end;
$$;

create or replace function chess_service.human_search(raw_token text, query text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  clean text;
begin
  actor := chess_private.as_profile(raw_token);
  clean := replace(replace(replace(btrim(coalesce(query, '')), '\', ''), '%', ''), '_', '');
  if char_length(clean) < 2 or char_length(clean) > 40 then
    raise exception 'Enter at least 2 characters of a display name.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', profiles.id,
      'displayName', profiles.display_name,
      'hasPortrait', profiles.portrait is not null
    ) order by profiles.display_name)
    from (
      select * from public.chess_profiles profiles
      where profiles.display_name ilike '%' || clean || '%'
        and profiles.id is distinct from actor
      order by profiles.display_name
      limit 8
    ) profiles
  ), '[]'::jsonb);
end;
$$;

create or replace function chess_service.human_create(
  raw_token text, expected uuid, kind text, creator_color text, category text, time_label text,
  base_ms integer, increment_ms integer, daily_days integer, opponent uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  record_chat boolean := false;
  invite text;
  match chess_private.human_matches;
  open_count integer;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then
    raise exception 'You can play only as your own Chess profile.';
  end if;
  if kind not in ('named', 'public') or creator_color not in ('white', 'black', 'random') then
    raise exception 'Choose white, black, or random.';
  end if;
  if kind = 'named' and (opponent is null or opponent = actor) then
    raise exception 'Choose a Chess member to challenge.';
  end if;
  if kind = 'named' and not exists (select 1 from public.chess_profiles profiles where profiles.id = opponent) then
    raise exception 'That profile was not found.';
  end if;
  if kind = 'public' and opponent is not null then
    raise exception 'The request could not be completed.';
  end if;
  perform chess_private.bump_rate(actor, 'human-create', 20);
  select count(*) into open_count from chess_private.human_matches games
    where games.creator_id = actor and games.status = 'open';
  if open_count >= 10 then
    raise exception 'You already have too many open challenges.';
  end if;
  select settings.auto_record_human_chat into record_chat
    from chess_private.account_settings settings where settings.profile_id = actor;
  invite := encode(extensions.gen_random_bytes(16), 'hex');
  insert into chess_private.human_matches (
    invite, kind, category, time_label, creator_id, creator_color, white_id, black_id, challenged_id,
    start_fen, base_ms, increment_ms, white_ms, black_ms, daily_days, creator_record
  ) values (
    invite, kind, category, time_label, actor, creator_color,
    case when creator_color = 'white' then actor else null end,
    case when creator_color = 'black' then actor else null end,
    case when kind = 'named' then opponent else null end,
    'rnbqkbnr/pppppppp/pppppppp/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    base_ms, coalesce(increment_ms, 0), base_ms, base_ms, daily_days, coalesce(record_chat, false)
  ) returning * into match;
  return chess_private.human_project(match, actor);
end;
$$;

create or replace function chess_service.human_cancel(raw_token text, expected uuid, match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  match chess_private.human_matches;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then
    raise exception 'You can play only as your own Chess profile.';
  end if;
  update chess_private.human_matches games
    set status = 'aborted', termination = 'cancelled', finished_at = clock_timestamp(), updated_at = clock_timestamp(), version = games.version + 1
    where games.id = match_id and games.creator_id = actor and games.status = 'open'
    returning * into match;
  if not found then
    raise exception 'That challenge is no longer open.';
  end if;
  return chess_private.human_project(match, actor);
end;
$$;

create or replace function chess_service.human_decline(raw_token text, expected uuid, match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  match chess_private.human_matches;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then
    raise exception 'You can play only as your own Chess profile.';
  end if;
  update chess_private.human_matches games
    set status = 'aborted', termination = 'declined', finished_at = clock_timestamp(), updated_at = clock_timestamp(), version = games.version + 1
    where games.id = match_id and games.kind = 'named' and games.challenged_id = actor and games.status = 'open'
    returning * into match;
  if not found then
    raise exception 'That challenge is no longer open.';
  end if;
  return chess_private.human_project(match, actor);
end;
$$;

drop function if exists chess_service.human_accept(text, uuid, uuid, text);
create or replace function chess_service.human_accept(raw_token text, expected uuid, match_id uuid, invite_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  record_chat boolean := false;
  match chess_private.human_matches;
  give_white boolean;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then
    raise exception 'You can play only as your own Chess profile.';
  end if;
  select settings.auto_record_human_chat into record_chat
    from chess_private.account_settings settings where settings.profile_id = actor;
  select * into match from chess_private.human_matches games
    where games.status = 'open'
      and ((match_id is not null and games.id = match_id) or (invite_code is not null and games.invite = invite_code))
    for update;
  if not found then
    raise exception 'That challenge is no longer open.';
  end if;
  if match.creator_id = actor then
    raise exception 'You cannot claim your own challenge.';
  end if;
  if match.kind = 'named' and match.challenged_id is distinct from actor then
    raise exception 'That challenge is no longer open.';
  end if;
  give_white := case
    when match.creator_color = 'black' then true
    when match.creator_color = 'white' then false
    else random() < 0.5
  end;
  update chess_private.human_matches games
    set status = 'active',
        white_id = case
          when games.creator_color = 'white' then games.creator_id
          when games.creator_color = 'black' then actor
          when give_white then actor else games.creator_id end,
        black_id = case
          when games.creator_color = 'black' then games.creator_id
          when games.creator_color = 'white' then actor
          when give_white then games.creator_id else actor end,
        opponent_record = coalesce(record_chat, false),
        clock_at = clock_timestamp(),
        deadline_at = case when games.daily_days is not null then clock_timestamp() + make_interval(days => games.daily_days) else null end,
        updated_at = clock_timestamp(),
        version = games.version + 1
    where games.id = match.id and games.status = 'open'
    returning * into match;
  if not found then
    raise exception 'That challenge is no longer open.';
  end if;
  return chess_private.human_project(match, actor);
end;
$$;

-- continued in the same migration

create or replace function chess_service.human_lists(raw_token text, which text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  rows jsonb;
begin
  perform chess_service.human_expire();
  actor := chess_private.as_profile(raw_token);
  if which = 'lobby' then
    select coalesce(jsonb_agg(chess_private.human_project(games, actor) order by games.created_at desc), '[]'::jsonb)
      into rows
    from chess_private.human_matches games
    where games.kind = 'public' and games.status = 'open';
  elsif which = 'incoming' then
    select coalesce(jsonb_agg(chess_private.human_project(games, actor) order by games.created_at desc), '[]'::jsonb)
      into rows
    from chess_private.human_matches games
    where games.kind = 'named' and games.status = 'open' and games.challenged_id = actor;
  else
    select coalesce(jsonb_agg(chess_private.human_project(games, actor) order by games.updated_at desc), '[]'::jsonb)
      into rows
    from chess_private.human_matches games
    where games.status in ('open', 'active')
      and (games.creator_id = actor or games.white_id = actor or games.black_id = actor or games.challenged_id = actor);
  end if;
  return rows;
end;
$$;

drop function if exists chess_service.human_get(text, uuid, text);
create or replace function chess_service.human_get(raw_token text, match_id uuid, invite_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  match chess_private.human_matches;
  messages jsonb;
begin
  perform chess_service.human_expire();
  actor := chess_private.as_profile(raw_token);
  select * into match from chess_private.human_matches games
    where (match_id is not null and games.id = match_id) or (invite_code is not null and invite_code <> '' and games.invite = invite_code);
  if not found then
    raise exception 'That game was not found.';
  end if;
  if match.status = 'open' and match.kind = 'named' and actor is distinct from match.creator_id and actor is distinct from match.challenged_id then
    raise exception 'That game was not found.';
  end if;
  if match.status <> 'open' and actor is distinct from match.white_id and actor is distinct from match.black_id and actor is distinct from match.creator_id then
    raise exception 'That game was not found.';
  end if;
  messages := case
    when actor = match.white_id or actor = match.black_id then chess_private.human_dialogue(match.id)
    else '[]'::jsonb
  end;
  return chess_private.human_project(match, actor) || jsonb_build_object('messages', messages);
end;
$$;

create or replace function chess_service.human_move(raw_token text, expected uuid, match_id uuid, expected_version integer, san text, next_result text, next_termination text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  match chess_private.human_matches;
  side text;
  elapsed integer;
  remaining integer;
  refreshed integer;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then
    raise exception 'You can play only as your own Chess profile.';
  end if;
  if san is null or san !~ '^(O-O-O|O-O|[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQ])?[+#]?)$' then
    raise exception 'That move is not legal.';
  end if;
  if next_result is not null and next_result not in ('1-0', '0-1', '1/2-1/2') then
    raise exception 'The result does not match the position.';
  end if;
  if next_termination is not null and next_termination not in ('checkmate', 'stalemate', 'threefold', 'fifty', 'insufficient', 'draw') then
    raise exception 'The ending is not one this service stores.';
  end if;
  select * into match from chess_private.human_matches games where games.id = match_id and games.status = 'active' for update;
  if not found then
    raise exception 'That game was not found.';
  end if;
  if match.version <> expected_version then
    raise exception 'The board changed. Reload this game.';
  end if;
  side := chess_private.human_turn(match);
  if (side = 'white' and match.white_id is distinct from actor) or (side = 'black' and match.black_id is distinct from actor) then
    raise exception 'It is not your turn.';
  end if;
  if match.daily_days is not null and match.deadline_at <= clock_timestamp() then
    match := chess_private.human_finish(match.id, case when side = 'white' then '0-1' else '1-0' end, 'timeout');
    return chess_private.human_project(match, actor) || jsonb_build_object('messages', chess_private.human_dialogue(match.id));
  end if;
  if match.base_ms is not null then
    elapsed := greatest(0, floor(extract(epoch from (clock_timestamp() - match.clock_at)) * 1000))::integer;
    remaining := case when side = 'white' then match.white_ms else match.black_ms end - elapsed;
    if remaining < 0 then
      match := chess_private.human_finish(match.id, case when side = 'white' then '0-1' else '1-0' end, 'timeout');
      return chess_private.human_project(match, actor) || jsonb_build_object('messages', chess_private.human_dialogue(match.id));
    end if;
    refreshed := remaining + match.increment_ms;
  end if;
  update chess_private.human_matches games
    set sans = games.sans || to_jsonb(san),
        white_ms = case when games.base_ms is null then games.white_ms when side = 'white' then refreshed else games.white_ms end,
        black_ms = case when games.base_ms is null then games.black_ms when side = 'black' then refreshed else games.black_ms end,
        clock_at = case when games.base_ms is null then games.clock_at else clock_timestamp() end,
        deadline_at = case when games.daily_days is not null then clock_timestamp() + make_interval(days => games.daily_days) else null end,
        draw_offer = null,
        status = case when next_result is null then 'active' else 'finished' end,
        result = next_result,
        termination = next_termination,
        finished_at = case when next_result is null then null else clock_timestamp() end,
        updated_at = clock_timestamp(),
        version = games.version + 1
    where games.id = match.id
    returning * into match;
  if match.status = 'finished' then
    perform chess_private.human_store_result(match, chess_private.human_dialogue(match.id), true);
  end if;
  return chess_private.human_project(match, actor) || jsonb_build_object('messages', chess_private.human_dialogue(match.id));
end;
$$;

create or replace function chess_service.human_resign(raw_token text, expected uuid, match_id uuid, expected_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  match chess_private.human_matches;
  side text;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then raise exception 'You can play only as your own Chess profile.'; end if;
  select * into match from chess_private.human_matches games where games.id = match_id and games.status = 'active' for update;
  if not found then raise exception 'That game was not found.'; end if;
  if match.version <> expected_version then raise exception 'The board changed. Reload this game.'; end if;
  if actor is distinct from match.white_id and actor is distinct from match.black_id then raise exception 'It is not your turn.'; end if;
  side := case when actor = match.white_id then 'white' else 'black' end;
  match := chess_private.human_finish(match.id, case when side = 'white' then '0-1' else '1-0' end, 'resign');
  return chess_private.human_project(match, actor) || jsonb_build_object('messages', chess_private.human_dialogue(match.id));
end;
$$;

create or replace function chess_service.human_draw(raw_token text, expected uuid, match_id uuid, expected_version integer, action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  match chess_private.human_matches;
  side text;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then raise exception 'You can play only as your own Chess profile.'; end if;
  if action not in ('offer', 'accept', 'decline') then raise exception 'That draw offer is not open.'; end if;
  select * into match from chess_private.human_matches games where games.id = match_id and games.status = 'active' for update;
  if not found then raise exception 'That game was not found.'; end if;
  if match.version <> expected_version then raise exception 'The board changed. Reload this game.'; end if;
  if actor is distinct from match.white_id and actor is distinct from match.black_id then raise exception 'It is not your turn.'; end if;
  side := case when actor = match.white_id then 'white' else 'black' end;
  if action = 'offer' then
    if chess_private.human_turn(match) is distinct from side then raise exception 'It is not your turn.'; end if;
    update chess_private.human_matches games set draw_offer = side, updated_at = clock_timestamp(), version = games.version + 1
      where games.id = match.id returning * into match;
  elsif action = 'decline' then
    if match.draw_offer is null or match.draw_offer = side then raise exception 'That draw offer is not open.'; end if;
    update chess_private.human_matches games set draw_offer = null, updated_at = clock_timestamp(), version = games.version + 1
      where games.id = match.id returning * into match;
  else
    if match.draw_offer is null or match.draw_offer = side then raise exception 'That draw offer is not open.'; end if;
    match := chess_private.human_finish(match.id, '1/2-1/2', 'agreement');
  end if;
  return chess_private.human_project(match, actor) || jsonb_build_object('messages', chess_private.human_dialogue(match.id));
end;
$$;

create or replace function chess_service.human_abort(raw_token text, expected uuid, match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  match chess_private.human_matches;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then raise exception 'You can play only as your own Chess profile.'; end if;
  update chess_private.human_matches games
    set status = 'aborted', termination = 'abort', finished_at = clock_timestamp(), updated_at = clock_timestamp(), version = games.version + 1
    where games.id = match_id and games.status = 'active' and jsonb_array_length(games.sans) = 0
      and (games.white_id = actor or games.black_id = actor)
    returning * into match;
  if not found then raise exception 'You can abort only before the first move.'; end if;
  return chess_private.human_project(match, actor);
end;
$$;

create or replace function chess_service.human_chat(raw_token text, expected uuid, match_id uuid, message_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  match chess_private.human_matches;
  clean text;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then raise exception 'You can play only as your own Chess profile.'; end if;
  clean := btrim(coalesce(message_body, ''));
  if char_length(clean) < 1 or char_length(clean) > 500 or clean ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'A dialogue message must be 1 to 500 characters.';
  end if;
  select * into match from chess_private.human_matches games where games.id = match_id;
  if not found or match.status <> 'active' then raise exception 'That game was not found.'; end if;
  if actor is distinct from match.white_id and actor is distinct from match.black_id then
    raise exception 'You can write in this game only as a player.';
  end if;
  perform chess_private.bump_rate(actor, 'human-chat', 40);
  insert into chess_private.human_messages (match_id, author_id, body) values (match.id, actor, clean);
  return chess_private.human_project(match, actor) || jsonb_build_object('messages', chess_private.human_dialogue(match.id));
end;
$$;

create or replace function chess_service.human_record(raw_token text, expected uuid, match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  match chess_private.human_matches;
  existing chess_private.human_results%rowtype;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor then raise exception 'You can play only as your own Chess profile.'; end if;
  select * into match from chess_private.human_matches games where games.id = match_id for update;
  if not found then raise exception 'That game was not found.'; end if;
  if actor is distinct from match.white_id and actor is distinct from match.black_id and actor is distinct from match.creator_id then
    raise exception 'You can write in this game only as a player.';
  end if;
  if actor = match.creator_id then
    update chess_private.human_matches games set creator_record = true where games.id = match.id returning * into match;
  else
    update chess_private.human_matches games set opponent_record = true where games.id = match.id returning * into match;
  end if;
  select * into existing from chess_private.human_results results
    where results.profile_id = actor and results.client_game_id = match.id;
  if found and existing.dialogue_recorded then
    raise exception 'This dialogue is already saved with your game.';
  end if;
  if match.status = 'finished' then
    update chess_private.human_results results
      set dialogue = chess_private.human_dialogue(match.id), dialogue_recorded = true
      where results.profile_id = actor and results.client_game_id = match.id;
  end if;
  return chess_private.human_project(match, actor) || jsonb_build_object('messages', chess_private.human_dialogue(match.id));
end;
$$;

create or replace function chess_service.human_results(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', results.id,
      'clientGameId', results.client_game_id,
      'matchId', results.match_id,
      'opponentId', results.opponent_id,
      'opponentName', results.opponent_name,
      'playerColor', results.player_color,
      'pgn', results.pgn,
      'startFen', results.start_fen,
      'moves', results.moves,
      'sans', results.sans,
      'result', results.result,
      'termination', results.termination,
      'category', results.category,
      'timeLabel', results.time_label,
      'pieceStyle', results.piece_style,
      'pieceColor', results.piece_color,
      'palette', results.palette,
      'kind', results.kind,
      'dialogue', results.dialogue,
      'dialogueRecorded', results.dialogue_recorded,
      'createdAt', results.created_at
    ) order by results.created_at desc)
    from (
      select * from chess_private.human_results results
      where results.profile_id = actor
      order by results.created_at desc
      limit 50
    ) results
  ), '[]'::jsonb);
end;
$$;

create or replace function chess_service.human_save(raw_token text, expected uuid, payload jsonb, game_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  game_id uuid := (payload->>'clientGameId')::uuid;
  created uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if expected is distinct from actor or (payload->>'expectedProfileId')::uuid is distinct from actor then
    raise exception 'This game belongs to a different Chess account.';
  end if;
  if game_hash is null or char_length(game_hash) <> 64 then
    raise exception 'The game record is incomplete.';
  end if;
  if coalesce(payload->>'rated', 'false') <> 'false' then
    raise exception 'Chess does not store a rated result.';
  end if;
  perform chess_private.bump_rate(actor, 'human-save', 30);
  if (select count(*) from chess_private.human_results results where results.profile_id = actor) >= 50 then
    raise exception 'This account has reached the saved-game limit.';
  end if;
  insert into chess_private.human_results (
    profile_id, client_game_id, opponent_name, player_color, pgn, start_fen, moves, sans, result, termination,
    category, time_label, piece_style, piece_color, palette, kind, payload_hash
  ) values (
    actor, game_id, payload->>'opponentName', payload->>'playerColor', payload->>'pgn', payload->>'startFen',
    payload->'moves', coalesce(payload->'sans', '[]'::jsonb), payload->>'result', payload->>'termination',
    payload->>'category', payload->>'timeLabel', payload->>'pieceStyle', payload->>'pieceColor', payload->>'palette',
    'pass', game_hash
  ) on conflict (profile_id, client_game_id) do nothing
  returning id into created;
  if created is null then
    if exists (
      select 1 from chess_private.human_results results
      where results.profile_id = actor and results.client_game_id = game_id and results.payload_hash = game_hash
    ) then
      select results.id into created from chess_private.human_results results
        where results.profile_id = actor and results.client_game_id = game_id;
      return jsonb_build_object('status', 'saved', 'id', created, 'duplicate', true);
    end if;
    raise exception 'This game was already saved with different moves.';
  end if;
  return jsonb_build_object('status', 'saved', 'id', created, 'duplicate', false);
end;
$$;

revoke all on function chess_service.human_record_setting_set(text, boolean) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_expire() from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_search(text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_create(text, uuid, text, text, text, text, integer, integer, integer, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_cancel(text, uuid, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_decline(text, uuid, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_accept(text, uuid, uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_lists(text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_get(text, uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_move(text, uuid, uuid, integer, text, text, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_resign(text, uuid, uuid, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_draw(text, uuid, uuid, integer, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_abort(text, uuid, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_chat(text, uuid, uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_record(text, uuid, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_results(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_save(text, uuid, jsonb, text) from public, anon, authenticated, chess_api;
grant execute on function chess_service.human_record_setting_set(text, boolean) to chess_server;
grant execute on function chess_service.human_expire() to chess_server;
grant execute on function chess_service.human_search(text, text) to chess_server;
grant execute on function chess_service.human_create(text, uuid, text, text, text, text, integer, integer, integer, uuid) to chess_server;
grant execute on function chess_service.human_cancel(text, uuid, uuid) to chess_server;
grant execute on function chess_service.human_decline(text, uuid, uuid) to chess_server;
grant execute on function chess_service.human_accept(text, uuid, uuid, text) to chess_server;
grant execute on function chess_service.human_lists(text, text) to chess_server;
grant execute on function chess_service.human_get(text, uuid, text) to chess_server;
grant execute on function chess_service.human_move(text, uuid, uuid, integer, text, text, text) to chess_server;
grant execute on function chess_service.human_resign(text, uuid, uuid, integer) to chess_server;
grant execute on function chess_service.human_draw(text, uuid, uuid, integer, text) to chess_server;
grant execute on function chess_service.human_abort(text, uuid, uuid) to chess_server;
grant execute on function chess_service.human_chat(text, uuid, uuid, text) to chess_server;
grant execute on function chess_service.human_record(text, uuid, uuid) to chess_server;
grant execute on function chess_service.human_results(text) to chess_server;
grant execute on function chess_service.human_save(text, uuid, jsonb, text) to chess_server;

commit;
