import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const db = 'chess_master_' + randomBytes(3).toString('hex');
const mina = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', token: 'mina-master-token' };
const julian = { master: '22222222-2222-4222-8222-222222222222', token: 'julian-master-token' };

function psql(database, sql) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], process.env];
  const result = spawnSync(command[0], command[1], { input: sql, encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return (result.stdout || '').trim();
}
function psqlFile(database, file) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env];
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

psql('postgres', `drop database if exists ${db}; create database ${db};`);
try {
  psql(db, `
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
    do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    create schema if not exists extensions;
    create extension if not exists pgcrypto schema extensions;
  `);
  psqlFile(db, 'supabase/chess_release.sql');
  psqlFile(db, 'supabase/chess_master_header.sql');
  psql(db, `
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${mina.master}', 'mina@example.com', '{"avatar_url":"http://evil.example/a.png","picture":"https://cdn.example/mina.png","full_name":"Meta Mina"}'),
      ('${julian.master}', 'julian@example.com', '{"picture":"https://cdn.example/julian.png","name":"julian@example.com"}');
    create table public.master_profiles (id uuid primary key, display_name text, avatar_type text);
    insert into public.master_profiles (id, display_name, avatar_type) values ('${mina.master}', 'Ada Lovelace', 'image/png');
    insert into public.chess_profiles (id, display_name) values ('${mina.profile}', 'Mina Chen');
    insert into chess_private.profile_owners (profile_id, owner_id) values ('${mina.profile}', '${mina.master}');
    insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at) values
      (chess_private.token_hash('${mina.token}'), chess_private.token_hash('csrf-mina'), '${mina.master}', '${mina.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day'),
      (chess_private.token_hash('${julian.token}'), chess_private.token_hash('csrf-julian'), '${julian.master}', null, clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day');
  `);
  const minaSession = JSON.parse(psql(db, `select chess_service.chess_session('${mina.token}');`));
  assert.equal(minaSession.authenticated, true);
  assert.equal(minaSession.profile.displayName, 'Mina Chen');
  assert.equal(minaSession.master.displayName, 'Ada Lovelace');
  assert.equal(minaSession.master.avatarUrl, 'https://cdn.example/mina.png');
  assert.equal(minaSession.master.avatarType, 'image/png');
  assert.equal(JSON.stringify(minaSession).includes(mina.master), false);
  assert.equal(JSON.stringify(minaSession).includes('mina@example.com'), false);
  const julianSession = JSON.parse(psql(db, `select chess_service.chess_session('${julian.token}');`));
  assert.equal(julianSession.profile, null);
  assert.equal(julianSession.master.displayName, 'julian');
  assert.equal(julianSession.master.avatarUrl, 'https://cdn.example/julian.png');
  assert.equal(JSON.stringify(julianSession).includes('Ada Lovelace'), false);
  assert.equal(JSON.stringify(julianSession).includes(julian.master), false);
  console.log('master header tests passed');
} finally {
  psql('postgres', `drop database if exists ${db};`);
}
