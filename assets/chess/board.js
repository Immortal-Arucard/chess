import { pieceName } from './rules.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];

function pieceSvg(type, color) {
  const fill = color === 'w' ? '#ffffff' : '#000000';
  const stroke = color === 'w' ? '#000000' : '#4fc3ff';
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="2.2" stroke-linejoin="round"`;
  const shapes = {
    p: `<circle cx="20" cy="14" r="5" ${common}/><path d="M12 30h16l-2-8H14z" ${common}/>`,
    r: `<path d="M11 12h4v3h3v-3h4v3h3v-3h4v6H11zm0 6h18v12H11z" ${common}/>`,
    n: `<path d="M14 31h14l-2-6 5-4c2-4-1-9-6-9-3 0-4 2-5 3l-4-2 1 6-4 3z" ${common}/>`,
    b: `<path d="M20 8l8 8-8 4-8-4z" ${common}/><path d="M16 22h8l2 9H14z" ${common}/><path d="M20 8v6" stroke="${stroke}" stroke-width="1.4"/>`,
    q: `<path d="M8 16l4 4 8-8 8 8 4-4-3 15H11z" ${common}/>`,
    k: `<path d="M18 7h4v4h4v4h-4v3h6l-2 13H14l-2-13h6V15h-4v-4h4z" ${common}/>`
  };
  return `<svg viewBox="0 0 40 40" aria-hidden="true">${shapes[type] || ''}</svg>`;
}

export function mountBoard(root, onSquare) {
  let focus = 'e2';
  let lastState = null;

  function order(orientation) {
    const files = orientation === 'w' ? FILES : FILES.slice().reverse();
    const ranks = orientation === 'w' ? RANKS : RANKS.slice().reverse();
    const squares = [];
    ranks.forEach((rank) => files.forEach((file) => squares.push(file + rank)));
    return squares;
  }

  function neighbor(square, dx, dy, orientation) {
    const file = FILES.indexOf(square[0]);
    const rank = Number(square[1]);
    const stepX = orientation === 'w' ? dx : -dx;
    const stepY = orientation === 'w' ? dy : -dy;
    const nextFile = file + stepX;
    const nextRank = rank + stepY;
    if (nextFile < 0 || nextFile > 7 || nextRank < 1 || nextRank > 8) return square;
    return FILES[nextFile] + String(nextRank);
  }

  function render(state) {
    lastState = state;
    const active = document.activeElement;
    const keepFocus = root.contains(active);
    const squares = order(state.orientation);
    if (!squares.includes(focus)) focus = squares[0];
    root.replaceChildren();
    root.className = 'board';
    root.setAttribute('role', 'grid');
    root.setAttribute('aria-label', 'Chessboard');
    root.setAttribute('aria-disabled', state.interactive ? 'false' : 'true');
    for (let row = 0; row < 8; row += 1) {
      const rowEl = document.createElement('div');
      rowEl.className = 'board-row';
      rowEl.setAttribute('role', 'row');
      for (let col = 0; col < 8; col += 1) {
        const square = squares[row * 8 + col];
        const piece = state.pieces[square];
        const button = document.createElement('button');
        button.type = 'button';
        const dark = (FILES.indexOf(square[0]) + Number(square[1])) % 2 === 1;
        button.className = 'square' + (dark ? ' dark' : '');
        button.dataset.square = square;
        button.setAttribute('role', 'gridcell');
        if (square === state.selected) button.classList.add('is-selected');
        if (state.lastMove && (state.lastMove.from === square || state.lastMove.to === square)) button.classList.add('is-last');
        if (state.checkSquare === square) button.classList.add('is-check');
        if (state.legal.includes(square)) {
          button.classList.add('is-legal');
          if (piece) button.classList.add('has-piece');
        }
        button.tabIndex = square === focus ? 0 : -1;
        button.disabled = !state.interactive;
        const side = piece ? (piece.color === 'w' ? 'white' : 'black') + ' ' + pieceName(piece.type) : 'empty';
        let label = square + ', ' + side;
        if (square === state.selected) label += ', selected';
        if (state.legal.includes(square)) label += piece ? ', legal capture' : ', legal move';
        if (state.checkSquare === square) label += ', in check';
        button.setAttribute('aria-label', label);
        if (piece) button.innerHTML = pieceSvg(piece.type, piece.color);
        button.addEventListener('click', () => {
          focus = square;
          if (state.interactive) onSquare(square);
        });
        button.addEventListener('keydown', (event) => {
          const key = event.key;
          let dx = 0;
          let dy = 0;
          if (key === 'ArrowLeft') dx = -1;
          else if (key === 'ArrowRight') dx = 1;
          else if (key === 'ArrowUp') dy = 1;
          else if (key === 'ArrowDown') dy = -1;
          else return;
          event.preventDefault();
          focus = neighbor(square, dx, dy, state.orientation);
          render(lastState);
          const next = root.querySelector(`[data-square="${focus}"]`);
          if (next) next.focus();
        });
        rowEl.append(button);
      }
      root.append(rowEl);
    }
    if (keepFocus) {
      const next = root.querySelector(`[data-square="${focus}"]`);
      if (next) next.focus();
    }
  }

  return { render };
}
