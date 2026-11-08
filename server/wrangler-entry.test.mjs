import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';
import { unstable_dev } from './node_modules/wrangler/wrangler-dist/cli.js';

const db = 'chess_wrangler_' + randomBytes(3).toString('hex');
const password = randomBytes(12).toString('hex');
const configPath = '/tmp/chess-wrangler.jsonc';

function psql(database, sql) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1'], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1'], process.env];
  const result = spawnSync(command[0], command[1], { input: sql, encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
function psqlFile(database, file) {
  const command = process.env.PGHOST ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env] : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file], process.env];
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', env: command[2] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

psql('postgres', `drop database if exists ${db}; create database ${db};`);
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
psql(db, `alter role chess_server login password '${password}'; grant connect on database ${db} to chess_server;`);
const host = process.env.PGHOST || '127.0.0.1';
const port = process.env.PGPORT || '5432';
writeFileSync(configPath, JSON.stringify({
  name: 'chess-api-test',
  main: 'server/worker.mjs',
  compatibility_date: '2026-11-08',
  compatibility_flags: ['nodejs_compat'],
  vars: {
    CHESS_ORIGIN: 'https://chess.example',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'publishable-test-key'
  },
  hyperdrive: [{
    binding: 'HYPERDRIVE',
    id: '0123456789abcdef0123456789abcdef',
    localConnectionString: `postgres://chess_server:${encodeURIComponent(password)}@${host}:${port}/${db}`
  }]
}, null, 2));

function start(config) {
  return unstable_dev('server/worker.mjs', {
    config,
    local: true,
    ip: '127.0.0.1',
    experimental: { disableExperimentalWarning: true }
  });
}
let worker;
try {
  const badPath = '/tmp/chess-wrangler-bad.jsonc';
  writeFileSync(badPath, JSON.stringify({
    name: 'chess-api-bad',
    main: 'server/worker.mjs',
    compatibility_date: '2026-11-08',
    compatibility_flags: ['nodejs_compat'],
    vars: { CHESS_ORIGIN: 'https://chess.example', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'publishable-test-key' },
    hyperdrive: [{ binding: 'HYPERDRIVE', id: '0123456789abcdef0123456789abcdef', localConnectionString: 'postgres://chess_server:wrong@127.0.0.1:1/none' }]
  }));
  const bad = await start(badPath);
  const failed = await bad.fetch('https://chess.example/api/session');
  assert.equal(failed.status, 503);
  await bad.stop();
  unlinkSync(badPath);
  worker = await start(configPath);
  const first = await worker.fetch('https://chess.example/api/session');
  const both = await Promise.all([
    worker.fetch('https://chess.example/api/session'),
    worker.fetch('https://chess.example/api/posts')
  ]);
  assert.equal(first.status, 200, await first.text());
  assert.equal(both[0].status, 200);
  assert.equal(both[1].status, 200);
  console.log('wrangler configured entry served session and posts after a failed connection');
} finally {
  if (worker) await worker.stop();
  unlinkSync(configPath);
  psql('postgres', `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${db}' and pid <> pg_backend_pid()`);
  psql('postgres', `drop database if exists ${db}`);
}
