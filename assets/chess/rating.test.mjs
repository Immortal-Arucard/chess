import assert from 'node:assert/strict';
import { drawShares, ratingResult, winGain } from './rating.js';

assert.equal(winGain(0), 10);
assert.equal(winGain(1), 11);
assert.equal(winGain(100), 11);
assert.equal(winGain(101), 12);
assert.equal(winGain(150), 12);
assert.equal(winGain(151), 13);
assert.equal(winGain(500), 19);
assert.equal(winGain(501), 20);
assert.equal(winGain(-1), 9);
assert.equal(winGain(-100), 9);
assert.equal(winGain(-101), 8);
assert.equal(winGain(-150), 8);
assert.equal(winGain(-151), 7);
assert.equal(winGain(-500), 1);
assert.equal(winGain(-501), 1);
assert.equal(winGain(-5000), 1);

const even = ratingResult('1-0', 1000, 1000);
assert.equal(even.white.delta, 10);
assert.equal(even.black.delta, -11);
assert.equal(even.black.after, 989);

const upset = ratingResult('1-0', 1000, 1101);
assert.equal(upset.white.delta, 12);
assert.equal(upset.white.after, 1012);
assert.equal(upset.black.delta, -13);
assert.equal(upset.black.after, 1088);

const clamped = ratingResult('0-1', 0, 400);
assert.equal(clamped.black.delta, winGain(-400));
assert.equal(clamped.white.after, 0);
assert.equal(clamped.white.delta, 0);

const higherBlack = drawShares(50, 100);
assert.equal(higherBlack.pool, 20);
assert.equal(higherBlack.white, 4);
assert.equal(higherBlack.black, 16);

const lowerBlack = drawShares(100, 50);
assert.equal(lowerBlack.pool, 20);
assert.equal(lowerBlack.white, 2);
assert.equal(lowerBlack.black, 18);

const equal = drawShares(500, 500);
assert.equal(equal.pool, 20);
assert.equal(equal.white, 3);
assert.equal(equal.black, 17);

const ceilCase = drawShares(0, 501);
assert.equal(ceilCase.pool, 21);
assert.equal(ceilCase.white, 5);
assert.equal(ceilCase.black, 17);
const applied = ratingResult('1/2-1/2', 0, 501);
assert.equal(applied.white.delta, 5);
assert.equal(applied.black.delta, 17);

console.log('rating formula tests passed');
