-- Incremental profile card. Apply once after chess_discussion.sql. Do not reapply chess_release.sql or chess_discussion.sql.
begin;

alter table public.chess_profiles
  add column bio text not null default '',
  add column portrait bytea,
  add column portrait_type text,
  add column background bytea,
  add column background_type text;

alter table public.chess_profiles
  add constraint chess_profiles_bio_len check (char_length(bio) <= 280),
  add constraint chess_profiles_bio_chars check (bio !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'),
  add constraint chess_profiles_portrait_type check (portrait_type is null or portrait_type in ('image/jpeg', 'image/png', 'image/webp')),
  add constraint chess_profiles_background_type check (background_type is null or background_type in ('image/jpeg', 'image/png', 'image/webp')),
  add constraint chess_profiles_portrait_pair check ((portrait is null) = (portrait_type is null)),
  add constraint chess_profiles_background_pair check ((background is null) = (background_type is null)),
  add constraint chess_profiles_portrait_len check (portrait is null or octet_length(portrait) between 16 and 524288),
  add constraint chess_profiles_background_len check (background is null or octet_length(background) between 16 and 524288);

grant select (bio) on public.chess_profiles to anon, authenticated;

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
    'hasBackground', profiles.background is not null
  )
  from public.chess_profiles profiles
  where profiles.id = profile
$$;

create function chess_service.profile_image(profile uuid, kind text)
returns table (mime text, bytes bytea)
language sql
stable
security definer
set search_path = ''
as $$
  select case when kind = 'portrait' then profiles.portrait_type else profiles.background_type end,
         case when kind = 'portrait' then profiles.portrait else profiles.background end
  from public.chess_profiles profiles
  where profiles.id = profile
    and kind in ('portrait', 'background')
    and case when kind = 'portrait' then profiles.portrait else profiles.background end is not null
$$;

create function chess_service.set_profile_bio(raw_token text, expected_author uuid, next_bio text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  owner uuid;
  clean text := btrim(coalesce(next_bio, ''));
begin
  actor := chess_private.as_profile(raw_token);
  if expected_author is distinct from actor then
    raise exception 'You can edit only your own Chess profile.';
  end if;
  if char_length(clean) > 280 or clean ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'A bio can be at most 280 characters.';
  end if;
  select owners.owner_id into owner from chess_private.profile_owners owners where owners.profile_id = actor;
  perform chess_private.bump_rate(owner, 'profile-card', 30);
  update public.chess_profiles profiles set bio = clean where profiles.id = actor;
  return chess_service.profile(actor);
end;
$$;

create function chess_service.set_profile_image(raw_token text, expected_author uuid, kind text, mime text, bytes bytea)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  owner uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if expected_author is distinct from actor then
    raise exception 'You can edit only your own Chess profile.';
  end if;
  if kind not in ('portrait', 'background')
    or mime not in ('image/jpeg', 'image/png', 'image/webp')
    or bytes is null
    or octet_length(bytes) < 16
    or octet_length(bytes) > 524288 then
    raise exception 'Use a JPEG, PNG, or WebP image up to 512 KB.';
  end if;
  if mime = 'image/jpeg' and not (get_byte(bytes, 0) = 255 and get_byte(bytes, 1) = 216 and get_byte(bytes, 2) = 255) then
    raise exception 'Use a JPEG, PNG, or WebP image up to 512 KB.';
  end if;
  if mime = 'image/png' and not (get_byte(bytes, 0) = 137 and get_byte(bytes, 1) = 80 and get_byte(bytes, 2) = 78 and get_byte(bytes, 3) = 71) then
    raise exception 'Use a JPEG, PNG, or WebP image up to 512 KB.';
  end if;
  if mime = 'image/webp' and not (
    convert_from(substring(bytes from 1 for 4), 'UTF8') = 'RIFF'
    and convert_from(substring(bytes from 9 for 4), 'UTF8') = 'WEBP'
  ) then
    raise exception 'Use a JPEG, PNG, or WebP image up to 512 KB.';
  end if;
  select owners.owner_id into owner from chess_private.profile_owners owners where owners.profile_id = actor;
  perform chess_private.bump_rate(owner, 'profile-card', 30);
  if kind = 'portrait' then
    update public.chess_profiles profiles set portrait = bytes, portrait_type = mime where profiles.id = actor;
  else
    update public.chess_profiles profiles set background = bytes, background_type = mime where profiles.id = actor;
  end if;
end;
$$;

create function chess_service.clear_profile_image(raw_token text, expected_author uuid, kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  owner uuid;
begin
  actor := chess_private.as_profile(raw_token);
  if expected_author is distinct from actor then
    raise exception 'You can edit only your own Chess profile.';
  end if;
  if kind not in ('portrait', 'background') then
    raise exception 'Use a JPEG, PNG, or WebP image up to 512 KB.';
  end if;
  select owners.owner_id into owner from chess_private.profile_owners owners where owners.profile_id = actor;
  perform chess_private.bump_rate(owner, 'profile-card', 30);
  if kind = 'portrait' then
    update public.chess_profiles profiles set portrait = null, portrait_type = null where profiles.id = actor;
  else
    update public.chess_profiles profiles set background = null, background_type = null where profiles.id = actor;
  end if;
end;
$$;

revoke all on function chess_service.profile(uuid) from public, anon, authenticated, chess_api;
revoke all on function chess_service.profile_image(uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.set_profile_bio(text, uuid, text) from public, anon, authenticated, chess_api;
revoke all on function chess_service.set_profile_image(text, uuid, text, text, bytea) from public, anon, authenticated, chess_api;
revoke all on function chess_service.clear_profile_image(text, uuid, text) from public, anon, authenticated, chess_api;

drop function chess_service.chess_rename(text, text);

create function chess_service.chess_rename(raw_token text, expected_author uuid, requested_name text)
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
  if expected_author is distinct from actor then
    raise exception 'You can edit only your own Chess profile.';
  end if;
  cleaned := btrim(regexp_replace(coalesce(requested_name, ''), '\s+', ' ', 'g'));
  if char_length(cleaned) < 1 or char_length(cleaned) > 40 or cleaned ~ '[[:cntrl:]]' then
    raise exception 'Enter a display name of 1 to 40 characters.';
  end if;
  update public.chess_profiles profiles set display_name = cleaned where profiles.id = actor;
  return jsonb_build_object('id', actor, 'displayName', cleaned);
end;
$$;

revoke all on function chess_service.chess_rename(text, uuid, text) from public, anon, authenticated, chess_api;
grant execute on function chess_service.profile(uuid) to chess_server;
grant execute on function chess_service.profile_image(uuid, text) to chess_server;
grant execute on function chess_service.set_profile_bio(text, uuid, text) to chess_server;
grant execute on function chess_service.set_profile_image(text, uuid, text, text, bytea) to chess_server;
grant execute on function chess_service.clear_profile_image(text, uuid, text) to chess_server;
grant execute on function chess_service.chess_rename(text, uuid, text) to chess_server;

commit;
