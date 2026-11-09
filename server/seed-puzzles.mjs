import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ratedFile = new URL('../puzzles/lichess-open-subset.json', import.meta.url);
const practiceFile = new URL('../puzzles/practice.json', import.meta.url);

function quote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function arrayLiteral(values) {
  return 'array[' + values.map((value) => quote(value)).join(',') + ']::text[]';
}

export function puzzleInsertSql(file, practice) {
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  const chunks = [];
  for (let index = 0; index < rows.length; index += 400) {
    const values = rows.slice(index, index + 400).map((row) => {
      const themes = (row.themes || []).filter((theme) => /^[A-Za-z0-9]+$/.test(theme));
      const moves = row.moves.filter((move) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move));
      return '(' + [quote(row.id), quote(row.fen), arrayLiteral(moves), arrayLiteral(themes), String(Number(row.rating)), practice ? 'true' : 'false'].join(',') + ')';
    });
    chunks.push('insert into chess_private.puzzles (id, fen, moves, themes, rating, practice) values\n' + values.join(',\n') + '\non conflict (id) do nothing;');
  }
  return chunks.join('\n');
}

function psql(sql) {
  const database = process.env.PGDATABASE || 'postgres';
  const command = process.env.PGHOST
    ? ['psql', ['-d', database, '-v', 'ON_ERROR_STOP=1']]
    : ['sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1']];
  const result = spawnSync(command[0], command[1], { input: sql, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql failed');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  psql(puzzleInsertSql(ratedFile, false));
  psql(puzzleInsertSql(practiceFile, true));
  console.log('puzzle seed loaded');
}
