import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const db = 'chess_exec_' + randomBytes(3).toString('hex');
const mina = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', token: 'mina-exec-token' };
const julian = { master: '22222222-2222-4222-8222-222222222222', profile: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', token: 'julian-exec-token' };
const helpers = [
  ['notification_put', 'chess_private.notification_put(uuid,uuid,text,text,text,text,text)', false],
  ['record_mentions', 'chess_private.record_mentions(uuid,text,uuid)', false],
  ['mention_list', 'chess_private.mention_list(uuid)', false],
  ['direct_pair', 'chess_private.direct_pair(uuid,uuid)', false],
  ['direct_visible', 'chess_private.direct_visible(uuid,uuid)', true]
];

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
    create table auth.users (id uuid primary key);
    do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    create schema if not exists extensions;
    create extension if not exists pgcrypto schema extensions;
  `);
  for (const file of [
    'supabase/chess_release.sql',
    'supabase/chess_discussion.sql',
    'supabase/chess_human.sql',
    'supabase/chess_messages.sql',
    'supabase/chess_push.sql',
    'supabase/chess_private_execute.sql'
  ]) psqlFile(db, file);

  for (const [name, signature, authenticated] of helpers) {
    const row = psql(db, `
      select has_function_privilege('public', '${signature}', 'execute')::text
        || ',' || has_function_privilege('anon', '${signature}', 'execute')::text
        || ',' || has_function_privilege('authenticated', '${signature}', 'execute')::text
        || ',' || has_function_privilege('chess_api', '${signature}', 'execute')::text
        || ',' || has_function_privilege('chess_server', '${signature}', 'execute')::text
        || ',' || has_function_privilege(current_user, '${signature}', 'execute')::text;
    `);
    assert.equal(row, `false,false,${authenticated},false,false,true`, name);
  }

  let denied = '';
  try {
    psql(db, `
      set role authenticated;
      select chess_private.notification_put(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
        'mention', 'x', '/community/discussion/', 'nope', 'nope'
      );
    `);
  } catch (err) {
    denied = String(err.message);
  }
  assert.match(denied, /permission denied/);
  psql(db, `
    insert into auth.users (id) values ('${mina.master}'), ('${julian.master}');
    insert into public.chess_profiles (id, display_name) values ('${mina.profile}', 'Mina'), ('${julian.profile}', 'Julian Park');
    insert into chess_private.profile_owners (profile_id, owner_id) values
      ('${mina.profile}', '${mina.master}'),
      ('${julian.profile}', '${julian.master}');
    insert into public.chess_direct_threads (low_id, high_id) values ('${mina.profile}', '${julian.profile}');
  `);
  const hidden = psql(db, `
    select set_config('request.jwt.claim.sub', '${mina.master}', false);
    set role authenticated;
    select count(*)::text from public.chess_direct_threads;
  `).split('\n').pop();
  assert.equal(hidden, '1');
  const stranger = psql(db, `
    select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
    set role authenticated;
    select count(*)::text from public.chess_direct_threads;
  `).split('\n').pop();
  assert.equal(stranger, '0');

  psql(db, `
    insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at) values
      (chess_private.token_hash('${mina.token}'), chess_private.token_hash('csrf'), '${mina.master}', '${mina.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day');
  `);
  const sent = JSON.parse(psql(db, `select chess_service.discussion_send('${mina.token}', 'Hello @"Julian Park"', '${mina.profile}');`));
  assert.equal(sent.mentions[0].displayName, 'Julian Park');
  const dm = JSON.parse(psql(db, `select chess_service.direct_send('${mina.token}', '${mina.profile}', '${julian.profile}', 'Still private');`));
  assert.equal(dm.body, 'Still private');
  console.log('private execute tests passed');
} finally {
  psql('postgres', `drop database if exists ${db};`);
}
