-- Community roster. Apply once after chess_human.sql.
-- Do not edit chess_release.sql, chess_discussion.sql, chess_profile_card.sql, or chess_human.sql.
-- Profiles have no deleted or hidden flag. Every row in public.chess_profiles is a joined Chess account.
-- Ratings are not invented. chess_private.profile_ratings is the place a future rating writer plugs in.
-- A missing row means that category is unrated. This file inserts no rating numbers.

begin;

create table if not exists chess_private.profile_ratings (
  profile_id uuid not null references public.chess_profiles (id) on delete cascade,
  category text not null,
  rating integer,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (profile_id, category),
  constraint profile_ratings_category check (category in ('bullet', 'blitz', 'rapid', 'daily', 'puzzles')),
  constraint profile_ratings_value check (rating is null or (rating between 100 and 4000))
);

revoke all on table chess_private.profile_ratings from public, anon, authenticated, chess_api, chess_server;
alter table chess_private.profile_ratings enable row level security;
alter table chess_private.profile_ratings force row level security;

create index if not exists chess_profiles_roster_name on public.chess_profiles (lower(display_name), id);
create index if not exists chess_profiles_roster_newest on public.chess_profiles (created_at desc, id desc);

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
  sort_mode text := case when sort_key = 'newest' then 'newest' else 'name' end;
  rating_requested boolean := sort_key = 'rating';
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
        'bullet', rates.bullet,
        'blitz', rates.blitz,
        'rapid', rates.rapid,
        'daily', rates.daily,
        'puzzles', rates.puzzles
      ) as ratings,
      row_number() over (
        order by
          case when sort_mode = 'newest' then profiles.created_at end desc,
          case when sort_mode = 'newest' then profiles.id end desc,
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
      )
    order by
      case when sort_mode = 'newest' then profiles.created_at end desc,
      case when sort_mode = 'newest' then profiles.id end desc,
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
    else
      next_cursor := jsonb_build_object('name', last_row.display_name, 'id', last_row.id);
    end if;
  end if;
  return jsonb_build_object(
    'total', total_count,
    'sort', sort_mode,
    'ratingSort', false,
    'ratingRequested', rating_requested,
    'members', members,
    'next', next_cursor
  );
end;
$$;

revoke all on function chess_service.community_roster(text, text, text, timestamptz, uuid, integer, text) from public, anon, authenticated, chess_api;
grant execute on function chess_service.community_roster(text, text, text, timestamptz, uuid, integer, text) to chess_server;

commit;
