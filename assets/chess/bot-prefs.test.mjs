import assert from 'node:assert/strict';
import { ELO_CHOICES, ELO_MAX, ELO_MIN, clampElo, defaultPrefs, loadPrefs, savePrefs, strengthCommands, strengthNote } from './bot-prefs.js';

assert.equal(ELO_MIN, 1320);
assert.equal(ELO_MAX, 3190);
assert.equal(clampElo(800), 1320);
assert.equal(clampElo(4000), 3190);
assert.equal(clampElo('nope'), 1600);
assert.deepEqual(strengthCommands(800), [
  'setoption name UCI_LimitStrength value true',
  'setoption name UCI_Elo value 1320'
]);
assert.deepEqual(strengthCommands(2500), [
  'setoption name UCI_LimitStrength value true',
  'setoption name UCI_Elo value 2500'
]);
assert.match(strengthNote(1320), /1320 to 3190/);
assert.match(strengthNote(1320), /not a measured rating/);
assert.ok(ELO_CHOICES.every((elo) => elo >= ELO_MIN && elo <= ELO_MAX));
assert.equal(ELO_CHOICES.includes(800), false);

const memory = {
  value: null,
  getItem() { return this.value; },
  setItem(_key, value) { this.value = value; }
};
assert.deepEqual(loadPrefs(memory), defaultPrefs());
savePrefs(memory, { palette: 'sea', pieceStyle: 'outline', pieceColor: 'ivory', elo: 3190, extra: 'no' });
assert.deepEqual(loadPrefs(memory), { palette: 'sea', pieceStyle: 'outline', pieceColor: 'ivory', elo: 3190 });
savePrefs(memory, { palette: 'nope', elo: 100 });
assert.equal(loadPrefs(memory).palette, 'midnight');
assert.equal(loadPrefs(memory).elo, 1600);
memory.getItem = () => '{';
assert.deepEqual(loadPrefs(memory), defaultPrefs());

console.log('bot preference tests passed');
