import { readFileSync, writeFileSync } from 'node:fs';

function strip(name) {
  return readFileSync(new URL('../supabase/' + name, import.meta.url), 'utf8')
    .replace(/^\uFEFF?/, '')
    .replace(/\bbegin\s*;/i, '')
    .replace(/\bcommit\s*;\s*$/i, '\n');
}

const sql = [
  '-- One transaction. Run this whole file once in the Supabase SQL editor.',
  '-- It contains chess_community.sql, chess_service.sql, and chess_http.sql with their inner commits removed.',
  'begin;',
  strip('chess_community.sql'),
  strip('chess_service.sql'),
  strip('chess_http.sql'),
  'commit;',
  ''
].join('\n');

if ((sql.match(/\bbegin\s*;/gi) || []).length !== 1 || (sql.match(/\bcommit\s*;/gi) || []).length !== 1) {
  throw new Error('The release migration must have exactly one begin and one commit.');
}
if (sql.includes('\\ir')) throw new Error('The release migration must be plain SQL.');
writeFileSync(new URL('../supabase/chess_release.sql', import.meta.url), sql);
console.log('wrote supabase/chess_release.sql', sql.length);
