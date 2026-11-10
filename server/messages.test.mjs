import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const db = 'chess_msg_' + randomBytes(3).toString('hex');
const mina = { master: '11111111-1111-4111-8111-111111111111', profile: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', token: 'mina-message-token' };
const julian = { master: '22222222-2222-4222-8222-222222222222', profile: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', token: 'julian-message-token' };
const nora = { master: '33333333-3333-4333-8333-333333333333', profile: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', token: 'nora-message-token' };
const twinA = { master: '44444444-4444-4444-8444-444444444444', profile: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4' };
const twinB = { master: '55555555-5555-4555-8555-555555555555', profile: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5' };

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
  psqlFile(db, 'supabase/chess_release.sql');
  psqlFile(db, 'supabase/chess_discussion.sql');
  psqlFile(db, 'supabase/chess_messages.sql');
  const people = [mina, julian, nora, twinA, twinB];
  psql(db, people.map((person) => `insert into auth.users (id) values ('${person.master}');`).join('\n'));
  psql(db, `
    insert into public.chess_profiles (id, display_name) values
      ('${mina.profile}', 'Mina'),
      ('${julian.profile}', 'Julian Park'),
      ('${nora.profile}', 'Nora'),
      ('${twinA.profile}', 'Twin'),
      ('${twinB.profile}', 'Twin');
    insert into chess_private.profile_owners (profile_id, owner_id) values
      ('${mina.profile}', '${mina.master}'),
      ('${julian.profile}', '${julian.master}'),
      ('${nora.profile}', '${nora.master}'),
      ('${twinA.profile}', '${twinA.master}'),
      ('${twinB.profile}', '${twinB.master}');
    insert into chess_private.browser_sessions (token_hash, csrf_hash, master_id, profile_id, expires_at, idle_expires_at) values
      (chess_private.token_hash('${mina.token}'), chess_private.token_hash('csrf-mina'), '${mina.master}', '${mina.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day'),
      (chess_private.token_hash('${julian.token}'), chess_private.token_hash('csrf-julian'), '${julian.master}', '${julian.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day'),
      (chess_private.token_hash('${nora.token}'), chess_private.token_hash('csrf-nora'), '${nora.master}', '${nora.profile}', clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day');
  `);
  const sent = JSON.parse(psql(db, `select chess_service.discussion_send('${mina.token}', 'Hello @"Julian Park" and @Mina and @"Julian Park" and @Twin and @Nobody', '${mina.profile}');`));
  assert.equal(sent.authorName, 'Mina');
  assert.deepEqual(sent.mentions.map((item) => item.displayName), ['Julian Park', 'Mina']);
  assert.equal(sent.body.slice(sent.mentions[0].start, sent.mentions[0].end), sent.mentions[0].text);
  assert.equal(sent.mentions[0].text, '@"Julian Park"');
  assert.equal(sent.mentions[1].text, '@Mina');
  const events = psql(db, `select recipient_id::text || ' ' || kind from chess_private.notification_events order by kind, recipient_id;`);
  assert.equal(events, julian.profile + ' mention');
  const again = JSON.parse(psql(db, `select chess_service.discussion_send('${mina.token}', '@"Julian Park"', '${mina.profile}');`));
  assert.equal(again.mentions.length, 1);
  const mentionCount = psql(db, `select count(*)::text from chess_private.notification_events where kind = 'mention' and recipient_id = '${julian.profile}';`);
  assert.equal(mentionCount, '2');

  const dm = JSON.parse(psql(db, `select chess_service.direct_send('${mina.token}', '${mina.profile}', '${julian.profile}', 'A private note');`));
  assert.equal(dm.body, 'A private note');
  assert.equal(dm.with.id, julian.profile);
  const page = JSON.parse(psql(db, `select chess_service.direct_page('${julian.token}', '${dm.threadId}', null, null, 20);`));
  assert.equal(page.messages.length, 1);
  assert.equal(page.with.displayName, 'Mina');
  const inbox = JSON.parse(psql(db, `select chess_service.direct_inbox('${mina.token}');`));
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].with.displayName, 'Julian Park');
  let denied = '';
  try {
    psql(db, `select chess_service.direct_page('${nora.token}', '${dm.threadId}', null, null, 20);`);
  } catch (err) {
    denied = String(err.message);
  }
  assert.match(denied, /That conversation was not found/);
  let self = '';
  try {
    psql(db, `select chess_service.direct_send('${mina.token}', '${mina.profile}', '${mina.profile}', 'me');`);
  } catch (err) {
    self = String(err.message);
  }
  assert.match(self, /Choose another Chess member/);
  const dmEvents = psql(db, `select count(*)::text from chess_private.notification_events where kind = 'direct_message' and recipient_id = '${julian.profile}' and actor_id = '${mina.profile}';`);
  assert.equal(dmEvents, '1');
  const selfEvents = psql(db, `select count(*)::text from chess_private.notification_events where recipient_id = actor_id;`);
  assert.equal(selfEvents, '0');

  const forced = psql(db, `select relrowsecurity::text || ',' || relforcerowsecurity::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'chess_direct_messages';`);
  assert.equal(forced, 'true,true');
  function see(master) {
    return psql(db, `
      select set_config('request.jwt.claim.sub', '${master}', false);
      set role authenticated;
      select count(*)::text from public.chess_direct_messages;
    `).split('\n').pop();
  }
  assert.equal(see(mina.master), '1');
  assert.equal(see(julian.master), '1');
  assert.equal(see(nora.master), '0');
  console.log('message tests passed');
} finally {
  psql('postgres', `drop database if exists ${db};`);
}
