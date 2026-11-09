import assert from 'node:assert/strict';
import { CATEGORIES, chatControls, cleanChatBody, clockView, formatClock, liveCategory, loadChatSize, outcome, playSan, replaySans, resolveTimeControl, saveChatSize, timeSummary, unreadCount } from './human-rules.js';
import { Chess } from '../vendor/chess.js/chess.js';

CATEGORIES.forEach((group) => {
  group.presets.forEach((preset) => {
    const resolved = resolveTimeControl({ category: group.id, preset: preset.id });
    assert.equal(resolved.category, group.id);
    assert.equal(resolved.label, preset.label);
    if (group.id !== 'daily' && group.id !== 'untimed') assert.equal(liveCategory(resolved.baseMs, resolved.incrementMs), group.id);
  });
});
assert.equal(resolveTimeControl({ category: 'bullet', preset: 'custom', minutes: 2, increment: 1 }).label, '2+1');
assert.throws(() => resolveTimeControl({ category: 'bullet', preset: 'custom', minutes: 5, increment: 0 }), /not available/);
assert.throws(() => resolveTimeControl({ category: 'blitz', preset: '1+0' }), /not available/);
assert.equal(resolveTimeControl({ category: 'daily', days: 14 }).label, '14 days');
assert.equal(timeSummary(resolveTimeControl({ category: 'rapid', preset: '15+10' })), 'Rapid · 15+10');

const mate = playSan(['f3', 'e5', 'g4'], 'Qh4#');
assert.equal(mate.outcome.termination, 'checkmate');
assert.equal(mate.outcome.result, '0-1');
const passant = playSan(['e4', 'a6', 'e5', 'd5'], 'exd6');
assert.equal(passant.san, 'exd6');
const castle = playSan(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'], 'O-O');
assert.equal(castle.san, 'O-O');
const queen = playSan([], 'h8=Q', 'k7/7P/8/8/8/8/8/K7 w - - 0 1');
assert.equal(queen.san, 'h8=Q+');
assert.equal(outcome(replaySans([], '4k3/8/8/8/8/8/8/4K3 w - - 0 1')).termination, 'insufficient');
assert.equal(outcome(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')).termination, 'stalemate');
const repeat = ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1'];
const threefold = playSan(repeat, 'Ng8');
assert.equal(threefold.outcome.termination, 'threefold');

const flagged = clockView({ category: 'bullet', baseMs: 60000, whiteMs: 1000, blackMs: 60000, clockAt: 0, turn: 'white' }, 1500);
assert.equal(flagged.flagged, 'white');
const daily = clockView({ category: 'daily', dailyDays: 1, deadlineAt: 5000, turn: 'black' }, 1000);
assert.equal(daily.dailyLeftMs, 4000);
assert.equal(formatClock(65000), '1:05');

const memory = new Map();
const storage = { getItem: (key) => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) };
assert.equal(saveChatSize(storage, 'ada', 'max'), 'max');
assert.equal(loadChatSize(storage, 'ada'), 'max');
assert.equal(loadChatSize(storage, 'bob'), 'normal');
assert.deepEqual(chatControls('normal').map((item) => item.action), ['min', 'max']);
assert.deepEqual(chatControls('max').map((item) => item.tip), ['Minimize', 'Restore']);
assert.equal(chatControls('min')[0].tip, 'Restore');
assert.equal(unreadCount('min', 2, 5), 3);
assert.equal(unreadCount('normal', 2, 5), 0);
assert.equal(cleanChatBody('  Hello  '), 'Hello');
assert.throws(() => cleanChatBody(''), /1 to 500/);
console.log('human rules tests passed');
