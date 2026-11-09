-- Puzzle serial numbers. Apply once after chess_puzzles.sql.
-- Do not edit chess_ratings.sql or chess_puzzles.sql.
-- Serials are stored on each puzzle and stay the same when the seed is loaded again.
-- The puzzle id remains the Lichess id. A puzzle opened by serial is summoned and unrated.

begin;

alter table chess_private.puzzles
  add column if not exists serial integer;

alter table chess_private.puzzles drop constraint if exists puzzles_serial_positive;
alter table chess_private.puzzles
  add constraint puzzles_serial_positive check (serial is null or serial > 0);

create unique index if not exists puzzles_serial on chess_private.puzzles (serial) where serial is not null;

alter table chess_private.puzzle_attempts
  add column if not exists summoned boolean not null default false;

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
    'lichessId', attempt.puzzle_id,
    'serial', puzzle.serial,
    'puzzleRating', attempt.puzzle_rating,
    'themes', to_jsonb(puzzle.themes),
    'setupFen', puzzle.fen,
    'applied', coalesce(to_jsonb(puzzle.moves[1:prefix]), '[]'::jsonb),
    'status', attempt.status,
    'summoned', attempt.summoned,
    'finished', attempt.status <> 'active',
    'delta', attempt.delta,
    'bonus', attempt.bonus,
    'gain', case
      when attempt.summoned then 0
      when attempt.status = 'solved' then coalesce(attempt.delta, 0) - coalesce(attempt.bonus, 0)
      else 0
    end,
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
  if attempt.summoned then
    update chess_private.puzzle_attempts stored
    set status = next_status,
        delta = 0,
        bonus = 0,
        streak_after = attempt.streak_before,
        rating_after = live,
        finished_at = clock_timestamp()
    where stored.id = attempt.id and stored.status = 'active'
    returning * into updated;
    if updated.id is null then
      select * into updated from chess_private.puzzle_attempts where id = attempt.id;
    end if;
    return updated;
  end if;
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

create or replace function chess_service.puzzle_summon(raw_token text, puzzle_serial integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  prefs chess_private.account_settings;
  open_attempt chess_private.puzzle_attempts;
  puzzle chess_private.puzzles;
  created chess_private.puzzle_attempts;
begin
  actor := chess_private.as_profile(raw_token);
  if puzzle_serial is null or puzzle_serial < 1 then
    raise exception 'That puzzle was not found.';
  end if;
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
  select * into puzzle from chess_private.puzzles where serial = puzzle_serial;
  if puzzle.id is null then
    raise exception 'That puzzle was not found.';
  end if;
  insert into chess_private.puzzle_attempts (
    profile_id, puzzle_id, user_rating, puzzle_rating, streak_before, next_index, summoned
  ) values (
    actor, puzzle.id, chess_private.rating_value(actor, 'puzzles'), puzzle.rating, prefs.puzzle_streak, 2, true
  ) returning * into created;
  return jsonb_build_object(
    'exhausted', false,
    'summoned', true,
    'attempt', chess_private.puzzle_view(created),
    'streak', prefs.puzzle_streak,
    'best', prefs.puzzle_best,
    'userRating', created.user_rating
  );
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
    'lichessId', page.puzzle_id,
    'serial', page.serial,
    'puzzleRating', page.puzzle_rating,
    'status', page.status,
    'summoned', page.summoned,
    'delta', page.delta,
    'bonus', page.bonus,
    'streakBefore', page.streak_before,
    'streakAfter', page.streak_after,
    'finishedAt', page.finished_at
  ) order by page.finished_at desc, page.id desc), '[]'::jsonb)
  into rows
  from (
    select attempts.id, attempts.puzzle_id, puzzles.serial, attempts.puzzle_rating, attempts.status,
      attempts.summoned, attempts.delta, attempts.bonus, attempts.streak_before, attempts.streak_after, attempts.finished_at
    from chess_private.puzzle_attempts attempts
    join chess_private.puzzles puzzles on puzzles.id = attempts.puzzle_id
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

revoke all on function chess_service.puzzle_summon(text, integer) from public, anon, authenticated, chess_api;
grant execute on function chess_service.puzzle_summon(text, integer) to chess_server;

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
          and seen.summoned = false
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
          and seen.summoned = false
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
          and seen.summoned = false
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
          and seen.summoned = false
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


commit;
