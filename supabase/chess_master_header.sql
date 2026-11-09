-- Owner-only master header for the signed-in Chess session.
-- Apply once after the other Chess SQL files.
-- The browser session is a Chess cookie, not a Supabase user JWT, so owner RLS
-- on public.master_profiles cannot be used from this origin directly.
-- This function reads that row only for the session owner and returns a display
-- name plus an https avatar URL. It does not return the master id, email, or
-- storage path.

begin;

create or replace function chess_service.chess_session(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  master uuid;
  actor uuid;
  name text;
  created timestamptz;
  stored_name text := '';
  avatar_type text := null;
  email text := '';
  meta jsonb := '{}'::jsonb;
  master_name text := 'Account';
  provider_name text := '';
  avatar_url text := '';
begin
  select sessions.master_id, sessions.profile_id into master, actor
  from chess_private.load_session(raw_token) sessions;
  if not found then
    return jsonb_build_object('authenticated', false, 'profile', null, 'master', null);
  end if;
  if actor is not null then
    select profiles.display_name, profiles.created_at into name, created
    from public.chess_profiles profiles where profiles.id = actor;
  end if;
  if to_regclass('public.master_profiles') is not null then
    begin
      execute 'select display_name, avatar_type from public.master_profiles where id = $1'
        into stored_name, avatar_type
        using master;
    exception
      when undefined_column then
        stored_name := '';
        avatar_type := null;
    end;
  end if;
  if to_regclass('auth.users') is not null
    and exists (
      select 1 from pg_attribute
      where attrelid = 'auth.users'::regclass
        and attname = 'raw_user_meta_data'
        and not attisdropped
    ) then
    begin
      execute 'select coalesce(email, ''''), coalesce(raw_user_meta_data, ''{}''::jsonb) from auth.users where id = $1'
        into email, meta
        using master;
    exception
      when undefined_column then
        email := '';
        meta := '{}'::jsonb;
    end;
    email := coalesce(email, '');
    meta := coalesce(meta, '{}'::jsonb);
  end if;
  provider_name := btrim(coalesce(meta->>'full_name', ''));
  if provider_name = '' then provider_name := btrim(coalesce(meta->>'name', '')); end if;
  if email <> '' and lower(provider_name) = lower(email) then provider_name := ''; end if;
  if btrim(coalesce(stored_name, '')) <> '' then
    master_name := btrim(stored_name);
  elsif provider_name <> '' then
    master_name := provider_name;
  elsif position('@' in coalesce(email, '')) > 1 then
    master_name := split_part(email, '@', 1);
  end if;
  if btrim(coalesce(meta->>'avatar_url', '')) ~ '^https://[^[:space:]]+$' then
    avatar_url := btrim(meta->>'avatar_url');
  elsif btrim(coalesce(meta->>'picture', '')) ~ '^https://[^[:space:]]+$' then
    avatar_url := btrim(meta->>'picture');
  end if;
  return jsonb_build_object(
    'authenticated', true,
    'profile', case when actor is null or name is null then null else jsonb_build_object(
      'id', actor,
      'displayName', name,
      'createdAt', created
    ) end,
    'master', jsonb_build_object(
      'displayName', master_name,
      'avatarUrl', avatar_url,
      'avatarType', nullif(btrim(coalesce(avatar_type, '')), '')
    )
  );
end;
$$;

commit;
