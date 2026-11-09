-- Chess ratings. Apply once after chess_roster.sql.
-- Do not edit chess_release.sql, chess_discussion.sql, chess_profile_card.sql, chess_human.sql, or chess_roster.sql.
-- Online human games can change bullet, blitz, rapid, daily, and untimed ratings.
-- Same-device games, bot games, and aborted games do not. Puzzles stay unrated.

begin;

alter table chess_private.profile_ratings drop constraint if exists profile_ratings_category;
alter table chess_private.profile_ratings drop constraint if exists profile_ratings_value;
alter table chess_private.profile_ratings
  add constraint profile_ratings_category check (category in ('bullet', 'blitz', 'rapid', 'daily', 'untimed', 'puzzles')),
  add constraint profile_ratings_value check (rating is null or rating >= 0);

alter table chess_private.human_matches
  add column if not exists rated boolean not null default false,
  add column if not exists white_rating integer,
  add column if not exists black_rating integer;

alter table chess_private.human_results
  add column if not exists rated boolean not null default false;

create table if not exists chess_private.rating_changes (
  match_id uuid not null references chess_private.human_matches (id) on delete cascade,
  profile_id uuid not null references public.chess_profiles (id) on delete cascade,
  category text not null,
  rating_before integer not null,
  rating_after integer not null,
  delta integer not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (match_id, profile_id),
  constraint rating_changes_category check (category in ('bullet', 'blitz', 'rapid', 'daily', 'untimed'))
);

revoke all on table chess_private.rating_changes from public, anon, authenticated, chess_api, chess_server;
alter table chess_private.rating_changes enable row level security;
alter table chess_private.rating_changes force row level security;

create or replace function chess_private.rating_value(profile uuid, cat text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when cat in ('bullet', 'blitz', 'rapid', 'daily', 'untimed') then coalesce((
      select stored.rating
      from chess_private.profile_ratings stored
      where stored.profile_id = profile and stored.category = cat
    ), 0)
    else null
  end;
$$;

create or replace function chess_private.rating_json(profile uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'bullet', chess_private.rating_value(profile, 'bullet'),
    'blitz', chess_private.rating_value(profile, 'blitz'),
    'rapid', chess_private.rating_value(profile, 'rapid'),
    'daily', chess_private.rating_value(profile, 'daily'),
    'untimed', chess_private.rating_value(profile, 'untimed'),
    'puzzles', (
      select stored.rating from chess_private.profile_ratings stored
      where stored.profile_id = profile and stored.category = 'puzzles'
    )
  );
$$;

create or replace function chess_private.win_gain(diff integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when diff = 0 then 10
    when diff > 0 and diff <= 100 then 11
    when diff > 100 then 11 + ceil((diff - 100)::numeric / 50)::integer
    when diff < 0 and diff >= -100 then 9
    else greatest(1, 9 - ceil(((-diff) - 100)::numeric / 50)::integer)
  end;
$$;

create or replace function chess_private.percent_ceil(pool integer, percent integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select (pool * percent + 99) / 100;
$$;

create or replace function chess_private.apply_match_ratings(match chess_private.human_matches)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  white_before integer;
  black_before integer;
  white_delta integer;
  black_delta integer;
  gain integer;
  pool integer;
  inserted integer;
begin
  if match.rated is not true or match.result is null then
    return;
  end if;
  if match.category not in ('bullet', 'blitz', 'rapid', 'daily', 'untimed') then
    return;
  end if;
  if match.white_id is null or match.black_id is null then
    return;
  end if;
  if match.white_rating is null or match.black_rating is null then
    return;
  end if;
  if match.result not in ('1-0', '0-1', '1/2-1/2') then
    return;
  end if;
  if exists (select 1 from chess_private.rating_changes changes where changes.match_id = match.id) then
    return;
  end if;
  white_before := match.white_rating;
  black_before := match.black_rating;
  if match.result = '1/2-1/2' then
    pool := chess_private.win_gain(black_before - white_before) + chess_private.win_gain(white_before - black_before);
    if white_before = black_before then
      white_delta := chess_private.percent_ceil(pool, 15);
      black_delta := chess_private.percent_ceil(pool, 85);
    elsif black_before < white_before then
      white_delta := chess_private.percent_ceil(pool, 10);
      black_delta := chess_private.percent_ceil(pool, 90);
    else
      white_delta := chess_private.percent_ceil(pool, 20);
      black_delta := chess_private.percent_ceil(pool, 80);
    end if;
  elsif match.result = '1-0' then
    gain := chess_private.win_gain(black_before - white_before);
    white_delta := gain;
    black_delta := greatest(0, black_before - (gain + 1)) - black_before;
  else
    gain := chess_private.win_gain(white_before - black_before);
    black_delta := gain;
    white_delta := greatest(0, white_before - (gain + 1)) - white_before;
  end if;
  insert into chess_private.rating_changes (match_id, profile_id, category, rating_before, rating_after, delta)
  values
    (match.id, match.white_id, match.category, white_before, white_before + white_delta, white_delta),
    (match.id, match.black_id, match.category, black_before, black_before + black_delta, black_delta)
  on conflict (match_id, profile_id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then
    return;
  end if;
  insert into chess_private.profile_ratings (profile_id, category, rating)
  values (match.white_id, match.category, greatest(0, white_delta))
  on conflict (profile_id, category) do update
    set rating = greatest(0, chess_private.profile_ratings.rating + white_delta),
        updated_at = clock_timestamp();
  insert into chess_private.profile_ratings (profile_id, category, rating)
  values (match.black_id, match.category, greatest(0, black_delta))
  on conflict (profile_id, category) do update
    set rating = greatest(0, chess_private.profile_ratings.rating + black_delta),
        updated_at = clock_timestamp();
end;
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
  white_delta integer;
  black_delta integer;
  opponent uuid;
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
  select max(changes.delta) filter (where changes.profile_id = match.white_id),
         max(changes.delta) filter (where changes.profile_id = match.black_id)
    into white_delta, black_delta
  from chess_private.rating_changes changes
  where changes.match_id = match.id;
  opponent := coalesce(
    match.challenged_id,
    case
      when match.white_id = match.creator_id then match.black_id
      when match.black_id = match.creator_id then match.white_id
      else null
    end
  );
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
    'creatorRating', chess_private.rating_value(match.creator_id, match.category),
    'opponentRating', case when opponent is null then null else chess_private.rating_value(opponent, match.category) end,
    'whiteId', match.white_id,
    'blackId', match.black_id,
    'whiteName', white_name,
    'blackName', black_name,
    'whiteRatingBefore', match.white_rating,
    'blackRatingBefore', match.black_rating,
    'whiteRating', case
      when match.white_rating is not null and white_delta is not null then match.white_rating + white_delta
      when match.white_rating is not null then match.white_rating
      when match.white_id is not null then chess_private.rating_value(match.white_id, match.category)
      else null end,
    'blackRating', case
      when match.black_rating is not null and black_delta is not null then match.black_rating + black_delta
      when match.black_rating is not null then match.black_rating
      when match.black_id is not null then chess_private.rating_value(match.black_id, match.category)
      else null end,
    'whiteDelta', white_delta,
    'blackDelta', black_delta,
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
    'rated', match.rated,
    'iAmRecording', recording,
    'invite', case when actor = match.creator_id then match.invite else null end,
    'startFen', match.start_fen,
    'serverNow', clock_timestamp(),
    'createdAt', match.created_at
  );
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
    dialogue, dialogue_recorded, rated
  ) values
    (match.white_id, match.id, match.id, match.black_id, coalesce(black_name, 'Black'), 'white', pgn, match.start_fen,
      moves, match.sans, match.result, coalesce(match.termination, ''), match.category, match.time_label,
      'standard', 'ink', 'midnight', 'online', case when match.creator_id = match.white_id and recorded and match.creator_record then dialogue when match.creator_id <> match.white_id and recorded and match.opponent_record then dialogue else null end,
      case when match.creator_id = match.white_id then match.creator_record else match.opponent_record end, match.rated),
    (match.black_id, match.id, match.id, match.white_id, coalesce(white_name, 'White'), 'black', pgn, match.start_fen,
      moves, match.sans, match.result, coalesce(match.termination, ''), match.category, match.time_label,
      'standard', 'ink', 'midnight', 'online', case when match.creator_id = match.black_id and recorded and match.creator_record then dialogue when match.creator_id <> match.black_id and recorded and match.opponent_record then dialogue else null end,
      case when match.creator_id = match.black_id then match.creator_record else match.opponent_record end, match.rated)
  on conflict (profile_id, client_game_id) do update set
    result = excluded.result,
    termination = excluded.termination,
    moves = excluded.moves,
    sans = excluded.sans,
    pgn = excluded.pgn,
    rated = excluded.rated,
    dialogue = coalesce(chess_private.human_results.dialogue, excluded.dialogue),
    dialogue_recorded = chess_private.human_results.dialogue_recorded or excluded.dialogue_recorded;
end;
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
  perform chess_private.apply_match_ratings(match);
  return match;
end;
$$;

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
  seated_white uuid;
  seated_black uuid;
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
  seated_white := case
    when match.creator_color = 'white' then match.creator_id
    when match.creator_color = 'black' then actor
    when give_white then actor else match.creator_id end;
  seated_black := case
    when match.creator_color = 'black' then match.creator_id
    when match.creator_color = 'white' then actor
    when give_white then match.creator_id else actor end;
  update chess_private.human_matches games
    set status = 'active',
        white_id = seated_white,
        black_id = seated_black,
        white_rating = case when games.rated then chess_private.rating_value(seated_white, games.category) else null end,
        black_rating = case when games.rated then chess_private.rating_value(seated_black, games.category) else null end,
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

drop function if exists chess_service.human_create(text, uuid, text, text, text, text, integer, integer, integer, uuid);
create or replace function chess_service.human_create(
  raw_token text, expected uuid, kind text, creator_color text, category text, time_label text,
  base_ms integer, increment_ms integer, daily_days integer, opponent uuid, rated boolean
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
  play_rated boolean;
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
  play_rated := coalesce(rated, false) and category in ('bullet', 'blitz', 'rapid', 'daily', 'untimed');
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
    start_fen, base_ms, increment_ms, white_ms, black_ms, daily_days, creator_record, rated
  ) values (
    invite, kind, category, time_label, actor, creator_color,
    case when creator_color = 'white' then actor else null end,
    case when creator_color = 'black' then actor else null end,
    case when kind = 'named' then opponent else null end,
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    base_ms, coalesce(increment_ms, 0), base_ms, base_ms, daily_days, coalesce(record_chat, false), play_rated
  ) returning * into match;
  return chess_private.human_project(match, actor);
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
      'rated', results.rated,
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
      'hasPortrait', profiles.portrait is not null,
      'ratings', chess_private.rating_json(profiles.id)
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

create or replace function chess_service.profile(profile uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', profiles.id,
    'displayName', profiles.display_name,
    'createdAt', profiles.created_at,
    'bio', profiles.bio,
    'hasPortrait', profiles.portrait is not null,
    'hasBackground', profiles.background is not null,
    'ratings', chess_private.rating_json(profiles.id)
  )
  from public.chess_profiles profiles
  where profiles.id = profile
$$;

create or replace function chess_service.community_roster(
  query text,
  sort_key text,
  before_name text,
  before_time timestamptz,
  before_id uuid,
  page_limit integer,
  client_ip text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean text := btrim(coalesce(query, ''));
  sort_mode text := case
    when sort_key in ('bullet', 'blitz', 'rapid', 'daily', 'untimed') then sort_key
    when sort_key = 'newest' then 'newest'
    else 'name'
  end;
  rating_sort boolean := sort_key in ('bullet', 'blitz', 'rapid', 'daily', 'untimed');
  lim integer := least(greatest(coalesce(page_limit, 24), 1), 30);
  address uuid := md5('roster-ip:' || coalesce(client_ip, ''))::uuid;
  global_bucket uuid := '00000000-0000-4000-8000-0000000000bb';
  total_count integer;
  members jsonb;
  next_cursor jsonb := null;
  last_row record;
begin
  if char_length(clean) > 40 or clean ~ '[[:cntrl:]]' then
    raise exception 'A name search can be at most 40 characters.';
  end if;
  clean := replace(replace(replace(clean, '\', ''), '%', ''), '_', '');
  if sort_mode = 'newest' then
    if (before_time is null) <> (before_id is null) then
      raise exception 'The request could not be completed.';
    end if;
  elsif rating_sort then
    if (before_name is null) <> (before_id is null) or (before_name is not null and before_name !~ '^-?[0-9]+$') then
      raise exception 'The request could not be completed.';
    end if;
  elsif (before_name is null) <> (before_id is null) then
    raise exception 'The request could not be completed.';
  end if;
  perform chess_private.bump_rate(address, 'roster', 120);
  perform chess_private.bump_rate(global_bucket, 'roster-global', 4000);
  select count(*) into total_count
  from public.chess_profiles profiles
  where clean = '' or profiles.display_name ilike '%' || clean || '%';
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'displayName', page.display_name,
    'hasPortrait', page.has_portrait,
    'ratings', page.ratings
  ) order by page.ord), '[]'::jsonb)
  into members
  from (
    select
      profiles.id,
      profiles.display_name,
      profiles.created_at,
      profiles.portrait is not null as has_portrait,
      jsonb_build_object(
        'bullet', coalesce(rates.bullet, 0),
        'blitz', coalesce(rates.blitz, 0),
        'rapid', coalesce(rates.rapid, 0),
        'daily', coalesce(rates.daily, 0),
        'untimed', coalesce(rates.untimed, 0),
        'puzzles', rates.puzzles
      ) as ratings,
      row_number() over (
        order by
          case when sort_mode = 'newest' then profiles.created_at end desc,
          case when sort_mode = 'newest' then profiles.id end desc,
          case when rating_sort then
            case sort_mode
              when 'bullet' then coalesce(rates.bullet, 0)
              when 'blitz' then coalesce(rates.blitz, 0)
              when 'rapid' then coalesce(rates.rapid, 0)
              when 'daily' then coalesce(rates.daily, 0)
              else coalesce(rates.untimed, 0)
            end
          end desc,
          case when rating_sort then profiles.id end desc,
          case when sort_mode = 'name' then lower(profiles.display_name) end asc,
          case when sort_mode = 'name' then profiles.id end asc
      ) as ord
    from public.chess_profiles profiles
    left join lateral (
      select
        max(stored.rating) filter (where stored.category = 'bullet') as bullet,
        max(stored.rating) filter (where stored.category = 'blitz') as blitz,
        max(stored.rating) filter (where stored.category = 'rapid') as rapid,
        max(stored.rating) filter (where stored.category = 'daily') as daily,
        max(stored.rating) filter (where stored.category = 'untimed') as untimed,
        max(stored.rating) filter (where stored.category = 'puzzles') as puzzles
      from chess_private.profile_ratings stored
      where stored.profile_id = profiles.id
    ) rates on true
    where (clean = '' or profiles.display_name ilike '%' || clean || '%')
      and (
        before_id is null
        or (
          sort_mode = 'name'
          and (lower(profiles.display_name), profiles.id) > (lower(before_name), before_id)
        )
        or (
          sort_mode = 'newest'
          and (profiles.created_at, profiles.id) < (before_time, before_id)
        )
        or (
          rating_sort
          and (
            case sort_mode
              when 'bullet' then coalesce(rates.bullet, 0)
              when 'blitz' then coalesce(rates.blitz, 0)
              when 'rapid' then coalesce(rates.rapid, 0)
              when 'daily' then coalesce(rates.daily, 0)
              else coalesce(rates.untimed, 0)
            end,
            profiles.id
          ) < (before_name::integer, before_id)
        )
      )
    order by
      case when sort_mode = 'newest' then profiles.created_at end desc,
      case when sort_mode = 'newest' then profiles.id end desc,
      case when rating_sort then
        case sort_mode
          when 'bullet' then coalesce(rates.bullet, 0)
          when 'blitz' then coalesce(rates.blitz, 0)
          when 'rapid' then coalesce(rates.rapid, 0)
          when 'daily' then coalesce(rates.daily, 0)
          else coalesce(rates.untimed, 0)
        end
      end desc,
      case when rating_sort then profiles.id end desc,
      case when sort_mode = 'name' then lower(profiles.display_name) end asc,
      case when sort_mode = 'name' then profiles.id end asc
    limit lim + 1
  ) page;
  if jsonb_array_length(members) > lim then
    select profiles.display_name, profiles.created_at, profiles.id
    into last_row
    from public.chess_profiles profiles
    where profiles.id = (members -> (lim - 1) ->> 'id')::uuid;
    select coalesce(jsonb_agg(item.value order by item.ord), '[]'::jsonb)
    into members
    from jsonb_array_elements(members) with ordinality as item(value, ord)
    where item.ord <= lim;
    if sort_mode = 'newest' then
      next_cursor := jsonb_build_object('createdAt', last_row.created_at, 'id', last_row.id);
    elsif rating_sort then
      next_cursor := jsonb_build_object('rating', (members -> (lim - 1) -> 'ratings' ->> sort_mode)::integer, 'id', last_row.id);
    else
      next_cursor := jsonb_build_object('name', last_row.display_name, 'id', last_row.id);
    end if;
  end if;
  return jsonb_build_object(
    'total', total_count,
    'sort', sort_mode,
    'ratingSort', rating_sort,
    'ratingRequested', sort_key = 'rating' or rating_sort,
    'members', members,
    'next', next_cursor
  );
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
  if san is null or san !~ '^((O-O-O|O-O)[+#]?|[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQ])?[+#]?)$' then
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
    if remaining <= 0 then
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
    perform chess_private.apply_match_ratings(match);
  end if;
  return chess_private.human_project(match, actor) || jsonb_build_object('messages', chess_private.human_dialogue(match.id));
end;
$$;

revoke all on function chess_private.rating_value(uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_private.rating_json(uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_private.win_gain(integer) from public, anon, authenticated, chess_api;
revoke all on function chess_private.percent_ceil(integer, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_private.apply_match_ratings(chess_private.human_matches) from public, anon, authenticated, chess_api;
revoke all on function chess_service.human_create(text, uuid, text, text, text, text, integer, integer, integer, uuid, boolean) from public, anon, authenticated, chess_api;
grant execute on function chess_service.human_create(text, uuid, text, text, text, text, integer, integer, integer, uuid, boolean) to chess_server;

commit;
