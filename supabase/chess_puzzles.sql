-- Puzzle trainer. Apply once after chess_ratings.sql.
-- Do not edit earlier SQL files.
-- Rated puzzles live in chess_private.puzzles. Load them with server/seed-puzzles.mjs.
-- Leaving before an incorrect move is abandoned: no rating change and no streak change.
-- Only an incorrect move fails a puzzle. Puzzle ratings themselves do not change.

begin;

alter table chess_private.account_settings
  add column if not exists puzzle_order text not null default 'weakest',
  add column if not exists puzzle_min integer,
  add column if not exists puzzle_max integer,
  add column if not exists puzzle_tier integer,
  add column if not exists puzzle_reset_at timestamptz,
  add column if not exists puzzle_streak integer not null default 0,
  add column if not exists puzzle_best integer not null default 0;

alter table chess_private.account_settings drop constraint if exists account_settings_puzzle_order;
alter table chess_private.account_settings
  add constraint account_settings_puzzle_order check (puzzle_order in ('weakest', 'tier', 'random')),
  add constraint account_settings_puzzle_range check (
    (puzzle_min is null or puzzle_min between 0 and 4000)
    and (puzzle_max is null or puzzle_max between 0 and 4000)
    and (puzzle_min is null or puzzle_max is null or puzzle_min <= puzzle_max)
    and (puzzle_tier is null or (puzzle_tier between 0 and 4000 and puzzle_tier % 100 = 0))
  ),
  add constraint account_settings_puzzle_streak check (puzzle_streak >= 0 and puzzle_best >= 0);

create table if not exists chess_private.puzzles (
  id text primary key,
  fen text not null,
  moves text[] not null,
  themes text[] not null default '{}',
  rating integer not null,
  practice boolean not null default false,
  constraint puzzles_id check (id ~ '^[A-Za-z0-9]{4,12}$'),
  constraint puzzles_moves check (cardinality(moves) >= 2),
  constraint puzzles_rating check (rating >= 0)
);

create table if not exists chess_private.puzzle_attempts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.chess_profiles (id) on delete cascade,
  puzzle_id text not null references chess_private.puzzles (id),
  status text not null default 'active',
  user_rating integer not null,
  puzzle_rating integer not null,
  next_index integer not null default 2,
  last_user_uci text,
  delta integer,
  bonus integer,
  streak_before integer not null,
  streak_after integer,
  rating_after integer,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  constraint puzzle_attempts_status check (status in ('active', 'solved', 'failed', 'abandoned')),
  constraint puzzle_attempts_index check (next_index >= 2)
);

create unique index if not exists puzzle_attempts_one_active
  on chess_private.puzzle_attempts (profile_id) where status = 'active';

create index if not exists puzzle_attempts_history
  on chess_private.puzzle_attempts (profile_id, finished_at desc, id desc);

create table if not exists chess_private.puzzle_moves (
  attempt_id uuid not null references chess_private.puzzle_attempts (id) on delete cascade,
  ply integer not null,
  uci text not null,
  correct boolean not null,
  millis integer not null,
  played_at timestamptz not null default clock_timestamp(),
  primary key (attempt_id, ply),
  constraint puzzle_moves_uci check (uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),
  constraint puzzle_moves_millis check (millis between 0 and 86400000)
);

create index if not exists puzzles_rating on chess_private.puzzles (rating) where practice = false;

revoke all on chess_private.puzzles from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.puzzle_attempts from public, anon, authenticated, chess_api, chess_server;
revoke all on chess_private.puzzle_moves from public, anon, authenticated, chess_api, chess_server;
alter table chess_private.puzzles enable row level security;
alter table chess_private.puzzle_attempts enable row level security;
alter table chess_private.puzzle_moves enable row level security;
alter table chess_private.puzzles force row level security;
alter table chess_private.puzzle_attempts force row level security;
alter table chess_private.puzzle_moves force row level security;

create or replace function chess_private.rating_value(profile uuid, cat text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when cat in ('bullet', 'blitz', 'rapid', 'daily', 'untimed', 'puzzles') then coalesce((
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
    'puzzles', chess_private.rating_value(profile, 'puzzles')
  );
$$;

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
  prefs chess_private.account_settings;
begin
  actor := chess_private.as_profile(raw_token);
  select settings.auto_save_bot_results, settings.auto_record_human_chat
    into enabled, record_chat
  from chess_private.account_settings settings where settings.profile_id = actor;
  select * into prefs from chess_private.account_settings settings where settings.profile_id = actor;
  return jsonb_build_object(
    'autoSaveBotResults', coalesce(enabled, false),
    'autoRecordHumanChat', coalesce(record_chat, false),
    'puzzleOrder', coalesce(prefs.puzzle_order, 'weakest'),
    'puzzleMin', prefs.puzzle_min,
    'puzzleMax', prefs.puzzle_max,
    'puzzleTier', prefs.puzzle_tier,
    'puzzleStreak', coalesce(prefs.puzzle_streak, 0),
    'puzzleBest', coalesce(prefs.puzzle_best, 0),
    'puzzleRating', chess_private.rating_value(actor, 'puzzles')
  );
end;
$$;

create or replace function chess_private.puzzle_ensure_settings(actor uuid)
returns chess_private.account_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  prefs chess_private.account_settings;
begin
  insert into chess_private.account_settings (profile_id)
  values (actor)
  on conflict (profile_id) do nothing;
  select * into prefs from chess_private.account_settings where profile_id = actor for update;
  return prefs;
end;
$$;

create or replace function chess_service.puzzle_settings_set(
  raw_token text,
  order_key text,
  min_rating integer,
  max_rating integer,
  tier integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if order_key not in ('weakest', 'tier', 'random') then
    raise exception 'That puzzle order is not available.';
  end if;
  if min_rating is not null and min_rating not between 0 and 4000
    or max_rating is not null and max_rating not between 0 and 4000
    or (min_rating is not null and max_rating is not null and min_rating > max_rating)
    or (tier is not null and (tier not between 0 and 4000 or tier % 100 <> 0)) then
    raise exception 'That puzzle range is not available.';
  end if;
  perform chess_private.puzzle_ensure_settings(actor);
  update chess_private.account_settings settings
  set puzzle_order = order_key,
      puzzle_min = min_rating,
      puzzle_max = max_rating,
      puzzle_tier = tier
  where settings.profile_id = actor;
  return chess_service.chess_settings(raw_token);
end;
$$;

create or replace function chess_private.puzzle_view(attempt chess_private.puzzle_attempts)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  puzzle chess_private.puzzles;
  played jsonb;
  streak integer := 0;
  best integer := 0;
  prefix integer;
begin
  select * into puzzle from chess_private.puzzles where id = attempt.puzzle_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'ply', moves.ply,
    'uci', moves.uci,
    'correct', moves.correct,
    'millis', moves.millis
  ) order by moves.ply), '[]'::jsonb)
  into played
  from chess_private.puzzle_moves moves
  where moves.attempt_id = attempt.id;
  select settings.puzzle_streak, settings.puzzle_best into streak, best
  from chess_private.account_settings settings where settings.profile_id = attempt.profile_id;
  prefix := greatest(attempt.next_index - 1, 1);
  return jsonb_build_object(
    'attemptId', attempt.id,
    'puzzleId', attempt.puzzle_id,
    'puzzleRating', attempt.puzzle_rating,
    'themes', to_jsonb(puzzle.themes),
    'setupFen', puzzle.fen,
    'applied', coalesce(to_jsonb(puzzle.moves[1:prefix]), '[]'::jsonb),
    'status', attempt.status,
    'finished', attempt.status <> 'active',
    'delta', attempt.delta,
    'bonus', attempt.bonus,
    'gain', case when attempt.status = 'solved' then coalesce(attempt.delta, 0) - coalesce(attempt.bonus, 0) else 0 end,
    'streakBefore', attempt.streak_before,
    'streakAfter', attempt.streak_after,
    'ratingAfter', attempt.rating_after,
    'streak', coalesce(streak, attempt.streak_before, 0),
    'best', coalesce(best, 0),
    'userRating', coalesce(attempt.rating_after, chess_private.rating_value(attempt.profile_id, 'puzzles')),
    'played', played,
    'solution', case
      when attempt.status in ('solved', 'failed', 'abandoned') then to_jsonb(puzzle.moves)
      else null
    end,
    'finishedAt', attempt.finished_at
  );
end;
$$;

create or replace function chess_private.puzzle_apply_result(
  attempt chess_private.puzzle_attempts,
  next_status text
) returns chess_private.puzzle_attempts
language plpgsql
security definer
set search_path = ''
as $$
declare
  live integer;
  gain integer;
  applied_bonus integer := 0;
  loss integer;
  applied_delta integer;
  new_streak integer;
  new_rating integer;
  updated chess_private.puzzle_attempts;
begin
  if attempt.status <> 'active' then
    return attempt;
  end if;
  live := chess_private.rating_value(attempt.profile_id, 'puzzles');
  if next_status = 'solved' then
    gain := chess_private.win_gain(attempt.puzzle_rating - attempt.user_rating);
    applied_bonus := attempt.streak_before;
    applied_delta := gain + applied_bonus;
    new_rating := live + applied_delta;
    new_streak := attempt.streak_before + 1;
  elsif next_status = 'failed' then
    loss := chess_private.win_gain(attempt.user_rating - attempt.puzzle_rating) + 1;
    new_rating := greatest(0, live - loss);
    applied_delta := new_rating - live;
    new_streak := 0;
  else
    applied_delta := 0;
    new_rating := live;
    new_streak := attempt.streak_before;
  end if;
  if next_status in ('solved', 'failed') then
    insert into chess_private.profile_ratings (profile_id, category, rating)
    values (attempt.profile_id, 'puzzles', greatest(0, applied_delta))
    on conflict (profile_id, category) do update
    set rating = greatest(0, chess_private.profile_ratings.rating + applied_delta);
    update chess_private.account_settings settings
    set puzzle_streak = new_streak,
        puzzle_best = greatest(settings.puzzle_best, new_streak)
    where settings.profile_id = attempt.profile_id;
  end if;
  update chess_private.puzzle_attempts stored
  set status = next_status,
      delta = applied_delta,
      bonus = applied_bonus,
      streak_after = new_streak,
      rating_after = new_rating,
      finished_at = clock_timestamp()
  where stored.id = attempt.id and stored.status = 'active'
  returning * into updated;
  if updated.id is null then
    select * into updated from chess_private.puzzle_attempts where id = attempt.id;
  end if;
  return updated;
end;
$$;

create or replace function chess_service.puzzle_current(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  prefs chess_private.account_settings;
  attempt chess_private.puzzle_attempts;
begin
  actor := chess_private.as_profile(raw_token);
  prefs := chess_private.puzzle_ensure_settings(actor);
  select * into attempt
  from chess_private.puzzle_attempts
  where profile_id = actor and status = 'active';
  return jsonb_build_object(
    'attempt', case when attempt.id is null then null else chess_private.puzzle_view(attempt) end,
    'streak', prefs.puzzle_streak,
    'best', prefs.puzzle_best,
    'userRating', chess_private.rating_value(actor, 'puzzles'),
    'order', prefs.puzzle_order,
    'min', prefs.puzzle_min,
    'max', prefs.puzzle_max,
    'tier', prefs.puzzle_tier
  );
end;
$$;

create or replace function chess_service.puzzle_next(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  prefs chess_private.account_settings;
  open_attempt chess_private.puzzle_attempts;
  chosen text;
  band integer;
  puzzle chess_private.puzzles;
  created chess_private.puzzle_attempts;
begin
  actor := chess_private.as_profile(raw_token);
  perform chess_private.bump_rate(actor, 'puzzle attempts', 120);
  prefs := chess_private.puzzle_ensure_settings(actor);
  select * into open_attempt
  from chess_private.puzzle_attempts
  where profile_id = actor and status = 'active'
  for update;
  if open_attempt.id is not null then
    perform chess_private.puzzle_apply_result(open_attempt, 'abandoned');
    select * into prefs from chess_private.account_settings where profile_id = actor;
  end if;
  if prefs.puzzle_order = 'weakest' then
    select puzzles.id into chosen
    from chess_private.puzzles puzzles
    where puzzles.practice = false
      and (prefs.puzzle_min is null or puzzles.rating >= prefs.puzzle_min)
      and (prefs.puzzle_max is null or puzzles.rating <= prefs.puzzle_max)
      and (prefs.puzzle_tier is null or puzzles.rating >= prefs.puzzle_tier)
      and not exists (
        select 1 from chess_private.puzzle_attempts seen
        where seen.profile_id = actor and seen.puzzle_id = puzzles.id
          and seen.status in ('solved', 'failed', 'abandoned')
          and seen.started_at >= coalesce(prefs.puzzle_reset_at, '-infinity'::timestamptz)
      )
    order by puzzles.rating asc, puzzles.id asc
    limit 1;
  elsif prefs.puzzle_order = 'random' then
    select puzzles.id into chosen
    from chess_private.puzzles puzzles
    where puzzles.practice = false
      and (prefs.puzzle_min is null or puzzles.rating >= prefs.puzzle_min)
      and (prefs.puzzle_max is null or puzzles.rating <= prefs.puzzle_max)
      and (prefs.puzzle_tier is null or puzzles.rating >= prefs.puzzle_tier)
      and not exists (
        select 1 from chess_private.puzzle_attempts seen
        where seen.profile_id = actor and seen.puzzle_id = puzzles.id
          and seen.status in ('solved', 'failed', 'abandoned')
          and seen.started_at >= coalesce(prefs.puzzle_reset_at, '-infinity'::timestamptz)
      )
    order by random()
    limit 1;
  else
    select floor(puzzles.rating / 100.0) * 100 into band
    from chess_private.puzzles puzzles
    where puzzles.practice = false
      and (prefs.puzzle_min is null or puzzles.rating >= prefs.puzzle_min)
      and (prefs.puzzle_max is null or puzzles.rating <= prefs.puzzle_max)
      and (prefs.puzzle_tier is null or puzzles.rating >= prefs.puzzle_tier)
      and not exists (
        select 1 from chess_private.puzzle_attempts seen
        where seen.profile_id = actor and seen.puzzle_id = puzzles.id
          and seen.status in ('solved', 'failed', 'abandoned')
          and seen.started_at >= coalesce(prefs.puzzle_reset_at, '-infinity'::timestamptz)
      )
    order by floor(puzzles.rating / 100.0) * 100 asc
    limit 1;
    if band is not null then
      select puzzles.id into chosen
      from chess_private.puzzles puzzles
      where puzzles.practice = false
        and floor(puzzles.rating / 100.0) * 100 = band
        and (prefs.puzzle_min is null or puzzles.rating >= prefs.puzzle_min)
        and (prefs.puzzle_max is null or puzzles.rating <= prefs.puzzle_max)
        and (prefs.puzzle_tier is null or puzzles.rating >= prefs.puzzle_tier)
        and not exists (
          select 1 from chess_private.puzzle_attempts seen
          where seen.profile_id = actor and seen.puzzle_id = puzzles.id
            and seen.status in ('solved', 'failed', 'abandoned')
            and seen.started_at >= coalesce(prefs.puzzle_reset_at, '-infinity'::timestamptz)
        )
      order by random()
      limit 1;
    end if;
  end if;
  if chosen is null then
    return jsonb_build_object(
      'exhausted', true,
      'attempt', null,
      'streak', prefs.puzzle_streak,
      'best', prefs.puzzle_best,
      'userRating', chess_private.rating_value(actor, 'puzzles')
    );
  end if;
  select * into puzzle from chess_private.puzzles where id = chosen;
  insert into chess_private.puzzle_attempts (
    profile_id, puzzle_id, user_rating, puzzle_rating, streak_before, next_index
  ) values (
    actor, puzzle.id, chess_private.rating_value(actor, 'puzzles'), puzzle.rating, prefs.puzzle_streak, 2
  ) returning * into created;
  return jsonb_build_object(
    'exhausted', false,
    'attempt', chess_private.puzzle_view(created),
    'streak', prefs.puzzle_streak,
    'best', prefs.puzzle_best,
    'userRating', created.user_rating
  );
end;
$$;

create or replace function chess_service.puzzle_move(raw_token text, attempt_id uuid, uci text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  attempt chess_private.puzzle_attempts;
  line text[];
  expected text;
  millis integer;
  ply integer;
begin
  actor := chess_private.as_profile(raw_token);
  perform chess_private.bump_rate(actor, 'puzzle attempts', 300);
  if uci !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' then
    raise exception 'That move is not legal.';
  end if;
  perform chess_private.puzzle_ensure_settings(actor);
  select * into attempt
  from chess_private.puzzle_attempts
  where id = attempt_id and profile_id = actor
  for update;
  if attempt.id is null then
    raise exception 'That puzzle attempt was not found.';
  end if;
  if attempt.status <> 'active' or attempt.last_user_uci = uci then
    return chess_private.puzzle_view(attempt);
  end if;
  select puzzles.moves into line from chess_private.puzzles puzzles where puzzles.id = attempt.puzzle_id;
  expected := line[attempt.next_index];
  millis := least(86400000, greatest(0, floor(extract(epoch from (
    clock_timestamp() - coalesce(
      (select max(moves.played_at) from chess_private.puzzle_moves moves where moves.attempt_id = attempt.id),
      attempt.started_at
    )
  )) * 1000)::integer));
  select coalesce(max(moves.ply), 0) + 1 into ply
  from chess_private.puzzle_moves moves where moves.attempt_id = attempt.id;
  if uci is distinct from expected then
    insert into chess_private.puzzle_moves (attempt_id, ply, uci, correct, millis)
    values (attempt.id, ply, uci, false, millis);
    attempt := chess_private.puzzle_apply_result(attempt, 'failed');
    return chess_private.puzzle_view(attempt);
  end if;
  insert into chess_private.puzzle_moves (attempt_id, ply, uci, correct, millis)
  values (attempt.id, ply, uci, true, millis);
  attempt.next_index := attempt.next_index + 1;
  if attempt.next_index <= cardinality(line) then
    attempt.next_index := attempt.next_index + 1;
  end if;
  update chess_private.puzzle_attempts stored
  set next_index = attempt.next_index,
      last_user_uci = uci
  where stored.id = attempt.id
  returning * into attempt;
  if attempt.next_index > cardinality(line) then
    attempt := chess_private.puzzle_apply_result(attempt, 'solved');
  end if;
  return chess_private.puzzle_view(attempt);
end;
$$;

create or replace function chess_service.puzzle_abandon(raw_token text, attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  attempt chess_private.puzzle_attempts;
begin
  actor := chess_private.as_profile(raw_token);
  select * into attempt
  from chess_private.puzzle_attempts
  where id = attempt_id and profile_id = actor
  for update;
  if attempt.id is null then
    raise exception 'That puzzle attempt was not found.';
  end if;
  if attempt.status = 'active' then
    attempt := chess_private.puzzle_apply_result(attempt, 'abandoned');
  end if;
  return chess_private.puzzle_view(attempt);
end;
$$;

create or replace function chess_service.puzzle_reset(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
begin
  actor := chess_private.as_profile(raw_token);
  perform chess_private.puzzle_ensure_settings(actor);
  update chess_private.account_settings settings
  set puzzle_reset_at = clock_timestamp()
  where settings.profile_id = actor;
  return chess_service.puzzle_current(raw_token);
end;
$$;

create or replace function chess_service.puzzle_attempts(
  raw_token text,
  before_time timestamptz,
  before_id uuid,
  page_limit integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  lim integer := least(greatest(coalesce(page_limit, 10), 1), 20);
  rows jsonb;
  next_cursor jsonb := null;
begin
  actor := chess_private.as_profile(raw_token);
  if (before_time is null) <> (before_id is null) then
    raise exception 'The request could not be completed.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'puzzleId', page.puzzle_id,
    'puzzleRating', page.puzzle_rating,
    'status', page.status,
    'delta', page.delta,
    'bonus', page.bonus,
    'streakBefore', page.streak_before,
    'streakAfter', page.streak_after,
    'finishedAt', page.finished_at
  ) order by page.finished_at desc, page.id desc), '[]'::jsonb)
  into rows
  from (
    select attempts.id, attempts.puzzle_id, attempts.puzzle_rating, attempts.status,
      attempts.delta, attempts.bonus, attempts.streak_before, attempts.streak_after, attempts.finished_at
    from chess_private.puzzle_attempts attempts
    where attempts.profile_id = actor
      and attempts.status in ('solved', 'failed', 'abandoned')
      and (before_id is null or (attempts.finished_at, attempts.id) < (before_time, before_id))
    order by attempts.finished_at desc, attempts.id desc
    limit lim + 1
  ) page;
  if jsonb_array_length(rows) > lim then
    next_cursor := jsonb_build_object(
      'finishedAt', rows -> (lim - 1) ->> 'finishedAt',
      'id', rows -> (lim - 1) ->> 'id'
    );
    select coalesce(jsonb_agg(item.value order by item.ord), '[]'::jsonb)
    into rows
    from jsonb_array_elements(rows) with ordinality as item(value, ord)
    where item.ord <= lim;
  end if;
  return jsonb_build_object('attempts', rows, 'next', next_cursor);
end;
$$;

create or replace function chess_service.puzzle_attempt(raw_token text, attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  attempt chess_private.puzzle_attempts;
begin
  actor := chess_private.as_profile(raw_token);
  select * into attempt
  from chess_private.puzzle_attempts
  where id = attempt_id and profile_id = actor and status in ('solved', 'failed', 'abandoned');
  if attempt.id is null then
    raise exception 'That puzzle attempt was not found.';
  end if;
  return chess_private.puzzle_view(attempt);
end;
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
    when sort_key in ('bullet', 'blitz', 'rapid', 'daily', 'untimed', 'puzzles') then sort_key
    when sort_key = 'newest' then 'newest'
    else 'name'
  end;
  rating_sort boolean := sort_key in ('bullet', 'blitz', 'rapid', 'daily', 'untimed', 'puzzles');
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
        'puzzles', coalesce(rates.puzzles, 0)
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
              when 'untimed' then coalesce(rates.untimed, 0)
              else coalesce(rates.puzzles, 0)
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
              when 'untimed' then coalesce(rates.untimed, 0)
              else coalesce(rates.puzzles, 0)
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
          when 'untimed' then coalesce(rates.untimed, 0)
          else coalesce(rates.puzzles, 0)
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

revoke all on function chess_private.puzzle_ensure_settings(uuid) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.puzzle_view(chess_private.puzzle_attempts) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.puzzle_apply_result(chess_private.puzzle_attempts, text) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_service.puzzle_settings_set(text, text, integer, integer, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.puzzle_current(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.puzzle_next(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.puzzle_move(text, uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.puzzle_abandon(text, uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.puzzle_reset(text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.puzzle_attempts(text, timestamptz, uuid, integer) from public, anon, authenticated, chess_api;
revoke all on function chess_service.puzzle_attempt(text, uuid) from public, anon, authenticated, chess_api;
grant execute on function chess_service.puzzle_settings_set(text, text, integer, integer, integer) to chess_server;
grant execute on function chess_service.puzzle_current(text) to chess_server;
grant execute on function chess_service.puzzle_next(text) to chess_server;
grant execute on function chess_service.puzzle_move(text, uuid, text) to chess_server;
grant execute on function chess_service.puzzle_abandon(text, uuid) to chess_server;
grant execute on function chess_service.puzzle_reset(text) to chess_server;
grant execute on function chess_service.puzzle_attempts(text, timestamptz, uuid, integer) to chess_server;
grant execute on function chess_service.puzzle_attempt(text, uuid) to chess_server;

commit;
