const STANDARD = {
  k: `<path stroke-linejoin="miter" d="M22.5 11.63V6M20 8h5" fill="none"/>
<path fill="{{FILL}}" stroke-linecap="butt" stroke-linejoin="miter" d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5"/>
<path fill="{{FILL}}" d="M12.5 37c5.5 3.5 14.5 3.5 20 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-2.5-7.5-12-10.5-16-4-3 6 6 10.5 6 10.5v7"/>
<path fill="none" d="M12.5 30c5.5-3 14.5-3 20 0m-20 3.5c5.5-3 14.5-3 20 0m-20 3.5c5.5-3 14.5-3 20 0"/>`,
  q: `<path fill="{{FILL}}" d="M9 26C17.5 24.5 30 24.5 36 26L38.5 13.5 31 25l-.3-14.1L25.5 24.5 22.5 10 19.5 24.5 14.3 10.9 14 25 6.5 13.5 9 26z"/>
<path fill="{{FILL}}" d="M9 26C9 28 10.5 28 11.5 30 12.5 31.5 12.5 31 12 33.5 10.5 34.5 11 36 11 36 9.5 37.5 11 38.5 11 38.5 17.5 39.5 27.5 39.5 34 38.5 34 38.5 35.5 37.5 34 36 34 36 34.5 34.5 33 33.5 32.5 31 32.5 31.5 33.5 30 34.5 28 36 28 36 26 27.5 24.5 17.5 24.5 9 26z"/>
<path fill="none" d="M11.5 30C15 29 30 29 33.5 30M12 33.5C18 32.5 27 32.5 33 33.5"/>
<circle cx="6" cy="12" r="2" fill="{{FILL}}"/>
<circle cx="14" cy="9" r="2" fill="{{FILL}}"/>
<circle cx="22.5" cy="8" r="2" fill="{{FILL}}"/>
<circle cx="31" cy="9" r="2" fill="{{FILL}}"/>
<circle cx="39" cy="12" r="2" fill="{{FILL}}"/>`,
  r: `<g transform="translate(0,0.3)">
<path fill="{{FILL}}" d="M9 39H36V36H9z"/>
<path fill="{{FILL}}" d="M12 36V32H33V36z"/>
<path fill="{{FILL}}" d="M11 14V9h4v2h5V9h5v2h5V9h4v5"/>
<path fill="{{FILL}}" d="M34 14L31 17H14L11 14"/>
<path fill="{{FILL}}" d="M31 17v12.5H14V17"/>
<path fill="{{FILL}}" d="M31 29.5L32.5 32h-20L14 29.5"/>
<path fill="none" d="M11 14h23"/>
</g>`,
  b: `<g transform="translate(0,0.6)">
<path fill="{{FILL}}" d="M9 36C12.39 35.03 19.11 36.43 22.5 34 25.89 36.43 32.61 35.03 36 36 36 36 37.65 36.54 39 38 38.32 38.97 37.35 38.99 36 38.5 32.61 37.53 25.89 38.96 22.5 37.5 19.11 38.96 12.39 37.53 9 38.5 7.65 38.99 6.68 38.97 6 38 7.35 36.54 9 36 9 36z"/>
<path fill="{{FILL}}" d="M15 32C17.5 34.5 27.5 34.5 30 32 30.5 30.5 30 30 30 30 30 27.5 27.5 26 27.5 26 33 24.5 33.5 14.5 22.5 10.5 11.5 14.5 12 24.5 17.5 26 17.5 26 15 27.5 15 30 15 30 14.5 30.5 15 32z"/>
<path fill="{{FILL}}" d="M25 8A2.5 2.5 0 1 1 20 8 2.5 2.5 0 1 1 25 8z"/>
<path fill="none" d="M17.5 26h10M15 30h15M22.5 15.5v5M20 18h5"/>
</g>`,
  n: `<g transform="translate(0,0.3)">
<path fill="{{FILL}}" d="M22 10C32.5 11 38.5 18 38 39H15C15 30 25 32.5 23 18"/>
<path fill="{{FILL}}" d="M24 18C24.38 20.91 18.45 25.37 16 27 13 29 13.18 31.34 11 31 9.958 30.06 12.41 27.96 11 28 10 28 11.19 29.23 10 30 9 30 5.997 31 6 26 6 24 12 14 12 14 12 14 13.89 12.1 14 10.5 13.27 9.506 13.5 8.5 13.5 7.5 14.5 6.5 16.5 10 16.5 10L18.5 10C18.5 10 19.28 8.008 21 7 22 7 22 10 22 10"/>
<path fill="{{EYE}}" d="M9.5 25.5A.5.5 0 1 1 8.5 25.5.5.5 0 1 1 9.5 25.5z"/>
<path fill="{{EYE}}" d="M15 15.5A.5 1.5 0 1 1 14 15.5.5 1.5 0 1 1 15 15.5z" transform="matrix(.866,.5,-.5,.866,9.693,-5.173)"/>
</g>`,
  p: `<path fill="{{FILL}}" d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03C15.41 27.09 11 31.58 11 39.5h23C34 31.58 29.59 27.09 26.59 26.03 28.06 24.84 29 23.03 29 21 29 18.59 27.67 16.5 25.72 15.38 26.21 14.71 26.5 13.89 26.5 13c0-2.21-1.79-4-4-4z"/>`
};

const BOLD = {
  p: `<path fill="{{PAINT}}" d="M22.5 6.2a5.2 5.2 0 0 1 3.6 9c1.6.8 2.7 2.6 2.7 4.6 0 2.1-.9 3.6-2.3 4.7 3.2 1.1 7 4.6 7 14.5H11.5c0-9.9 3.8-13.4 7-14.5-1.4-1.1-2.3-2.6-2.3-4.7 0-2 1.1-3.8 2.7-4.6a5.2 5.2 0 0 1 3.6-9z"/>`,
  r: `<path fill="{{PAINT}}" d="M8 40h29v-4h-3.2V17.2H36V12H31V7h-5v3.2h-2.2V7h-2.6v3.2H19V7h-5v5H9v5.2h2.2V36H8z"/>`,
  n: `<path fill="{{PAINT}}" d="M37 39H12c0-6 6-8 8-14-6 1-11-2-12-8 0-2 1-5 4-7l2-5 4 3c1-3 5-4 8-2 3-1 8 1 8 6 1 5-2 8-6 9 2 5 9 8 9 18z"/><path fill="{{EYE}}" d="M15 18.5a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0z"/>`,
  b: `<path fill="{{PAINT}}" d="M22.5 5.5c-1.6 1.2-6 6.2-6 12.2 0 3.2 1.2 5.4 2.4 6.8-3.2 1.2-5.4 3.4-6.6 6.2L9 40h27l-3.3-9.3c-1.2-2.8-3.4-5-6.6-6.2 1.2-1.4 2.4-3.6 2.4-6.8 0-6-4.4-11-6-12.2z"/><path fill="none" stroke="{{EYE}}" stroke-width="2.2" d="M22.5 14v8M19 18h7"/>`,
  q: `<path fill="{{PAINT}}" d="M7 16l4.2 2.2L14 9l4.6 8.2L22.5 6l3.9 11.2L31 9l2.8 9.2L38 16l-3 10H10z"/><path fill="{{PAINT}}" d="M10 26c8-1.6 17-1.6 25 0 0 2-1.5 3-2.5 5s0 2 .5 4c1.2 1 1 2.5.5 3.5-1.2 1.4.2 2.2.2 2.2-6 1.4-18 1.4-24 0 0 0 1.4-.8.2-2.2-.5-1-.7-2.5.5-3.5.5-2 .5-2 .5-4-1-2-2.5-3-2.5-5z"/><circle cx="7" cy="15" r="2.1" fill="{{PAINT}}"/><circle cx="14" cy="8" r="2.1" fill="{{PAINT}}"/><circle cx="22.5" cy="5" r="2.2" fill="{{PAINT}}"/><circle cx="31" cy="8" r="2.1" fill="{{PAINT}}"/><circle cx="38" cy="15" r="2.1" fill="{{PAINT}}"/>`,
  k: `<path fill="{{PAINT}}" d="M20.2 4h4.6v3.2H29V12h-4.2v2.2c4.2.6 8.2 3.2 9.6 8.2 1.6 5.4-1.2 8.2-4.6 9.8V39c-5.2 2.4-10.6 2.4-15.8 0v-6.8c-3.4-1.6-6.2-4.4-4.6-9.8 1.4-5 5.4-7.6 9.6-8.2V12H16V7.2h4.2z"/><path fill="none" stroke="{{EYE}}" stroke-width="2.4" stroke-linejoin="miter" d="M22.5 4v8M18.6 7.2h7.8"/>`
};

export function pieceMarkup(type, side, style, colors) {
  const fill = side === 'w' ? colors.lightFill : colors.darkFill;
  const stroke = side === 'w' ? colors.lightStroke : colors.darkStroke;
  const chosen = style === 'bold' || style === 'contour' ? 'bold' : 'standard';
  const source = (chosen === 'bold' ? BOLD : STANDARD)[type];
  if (!source) return '';
  const paint = style === 'contour' ? 'none' : fill;
  const width = style === 'contour' ? '2.6' : '1.5';
  const body = source
    .replaceAll('{{PAINT}}', paint)
    .replaceAll('{{FILL}}', fill)
    .replaceAll('{{EYE}}', stroke);
  return `<svg viewBox="0 0 45 45" aria-hidden="true" fill="${paint}" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
}
