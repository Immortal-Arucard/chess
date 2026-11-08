import assert from 'node:assert/strict';
import { pieceMarkup } from './piece-sets.js';

const colors = { lightFill: '#ffffff', lightStroke: '#111111', darkFill: '#111111', darkStroke: '#4fc3ff' };

const standard = {
  k: pieceMarkup('k', 'w', 'standard', colors),
  q: pieceMarkup('q', 'b', 'standard', colors),
  r: pieceMarkup('r', 'w', 'standard', colors),
  b: pieceMarkup('b', 'b', 'standard', colors),
  n: pieceMarkup('n', 'w', 'standard', colors),
  p: pieceMarkup('p', 'b', 'standard', colors)
};
assert.match(standard.k, /M22\.5 11\.63V6/);
assert.match(standard.q, /<circle /);
assert.match(standard.r, /M11 14V9h4/);
assert.match(standard.b, /M22\.5 15\.5v5/);
assert.match(standard.n, /M22 10C32\.5 11/);
assert.match(standard.p, /M22\.5 9c-2\.21/);
assert.match(standard.q, /fill="#111111"/);
assert.match(standard.q, /stroke="#4fc3ff"/);

const bold = pieceMarkup('n', 'w', 'bold', colors);
const contour = pieceMarkup('n', 'b', 'contour', colors);
assert.notEqual(bold, standard.n);
assert.match(contour, /fill="none"/);
assert.match(contour, /stroke="#4fc3ff"/);
assert.equal(pieceMarkup('k', 'w', 'line', colors).includes('M22.5 11.63V6'), true);

console.log('piece set tests passed');
