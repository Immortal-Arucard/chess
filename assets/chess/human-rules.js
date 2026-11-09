import { Chess, DEFAULT_POSITION } from '../vendor/chess.js/chess.js';

export const STANDARD_FEN = DEFAULT_POSITION;

export const CATEGORIES = [
  {
    id: 'bullet',
    label: 'Bullet',
    presets: [
      { id: '1+0', label: '1+0', baseMs: 60000, incrementMs: 0 },
      { id: '1+1', label: '1+1', baseMs: 60000, incrementMs: 1000 },
      { id: '2+1', label: '2+1', baseMs: 120000, incrementMs: 1000 }
    ]
  },
  {
    id: 'blitz',
    label: 'Blitz',
    presets: [
      { id: '3+0', label: '3+0', baseMs: 180000, incrementMs: 0 },
      { id: '3+2', label: '3+2', baseMs: 180000, incrementMs: 2000 },
      { id: '5+0', label: '5+0', baseMs: 300000, incrementMs: 0 }
    ]
  },
  {
    id: 'rapid',
    label: 'Rapid',
    presets: [
      { id: '10+0', label: '10+0', baseMs: 600000, incrementMs: 0 },
      { id: '15+10', label: '15+10', baseMs: 900000, incrementMs: 10000 },
      { id: '30+0', label: '30+0', baseMs: 1800000, incrementMs: 0 }
    ]
  },
  {
    id: 'daily',
    label: 'Daily',
    presets: [
      { id: '1d', label: '1 day', days: 1 },
      { id: '3d', label: '3 days', days: 3 },
      { id: '7d', label: '7 days', days: 7 }
    ]
  },
  {
    id: 'untimed',
    label: 'Untimed',
    presets: [{ id: 'untimed', label: 'Untimed' }]
  }
];

const CUSTOM = {
  bullet: [1, 2, 0, 2],
  blitz: [3, 8, 0, 10],
  rapid: [10, 30, 0, 30]
};

export function estimatedSeconds(baseMs, incrementMs) {
  return baseMs / 1000 + (incrementMs / 1000) * 40;
}

export function liveCategory(baseMs, incrementMs) {
  const estimated = estimatedSeconds(baseMs, incrementMs);
  if (estimated < 180) return 'bullet';
  if (estimated < 600) return 'blitz';
  if (estimated <= 1800) return 'rapid';
  return '';
}

export function resolveTimeControl(input) {
  const category = String((input && input.category) || '');
  const group = CATEGORIES.find((item) => item.id === category);
  if (!group) throw new Error('That time control is not available.');
  const presetId = input && input.preset ? String(input.preset) : '';
  if (category === 'untimed') {
    return { category, label: 'Untimed', baseMs: null, incrementMs: 0, dailyDays: null };
  }
  if (presetId && presetId !== 'custom') {
    const preset = group.presets.find((item) => item.id === presetId);
    if (!preset) throw new Error('That time control is not available.');
    if (category === 'daily') {
      return { category, label: preset.label, baseMs: null, incrementMs: 0, dailyDays: preset.days };
    }
    if (liveCategory(preset.baseMs, preset.incrementMs) !== category) throw new Error('That time control is not available.');
    return { category, label: preset.label, baseMs: preset.baseMs, incrementMs: preset.incrementMs, dailyDays: null };
  }
  if (category === 'daily') {
    const days = Number(input && input.days);
    if (!Number.isInteger(days) || days < 1 || days > 14) throw new Error('That time control is not available.');
    return { category, label: days === 1 ? '1 day' : days + ' days', baseMs: null, incrementMs: 0, dailyDays: days };
  }
  const bounds = CUSTOM[category];
  const minutes = Number(input && input.minutes);
  const increment = Number(input && input.increment);
  if (!bounds || !Number.isInteger(minutes) || !Number.isInteger(increment)) throw new Error('That time control is not available.');
  if (minutes < bounds[0] || minutes > bounds[1] || increment < bounds[2] || increment > bounds[3]) {
    throw new Error('That time control is not available.');
  }
  const baseMs = minutes * 60000;
  const incrementMs = increment * 1000;
  if (liveCategory(baseMs, incrementMs) !== category) throw new Error('That time control is not available.');
  return { category, label: minutes + '+' + increment, baseMs, incrementMs, dailyDays: null };
}

export function timeSummary(control) {
  if (!control) return '';
  const group = CATEGORIES.find((item) => item.id === control.category);
  return (group ? group.label : control.category) + ' · ' + control.label;
}

export function outcome(game) {
  if (game.isCheckmate()) return { result: game.turn() === 'w' ? '0-1' : '1-0', termination: 'checkmate', over: true };
  if (game.isStalemate()) return { result: '1/2-1/2', termination: 'stalemate', over: true };
  if (game.isThreefoldRepetition()) return { result: '1/2-1/2', termination: 'threefold', over: true };
  if (game.isDrawByFiftyMoves()) return { result: '1/2-1/2', termination: 'fifty', over: true };
  if (game.isInsufficientMaterial()) return { result: '1/2-1/2', termination: 'insufficient', over: true };
  if (game.isDraw()) return { result: '1/2-1/2', termination: 'draw', over: true };
  return { result: '*', termination: '', over: false };
}

export function replaySans(sans, startFen) {
  const game = new Chess();
  if (startFen && startFen !== STANDARD_FEN) game.load(startFen);
  (sans || []).forEach((san) => {
    try {
      if (!game.move(san)) throw new Error('The move list does not replay.');
    } catch (err) {
      if (err && err.message === 'The move list does not replay.') throw err;
      throw new Error('The move list does not replay.');
    }
  });
  return game;
}

export function playSan(sans, san, startFen) {
  const game = replaySans(sans, startFen);
  const turn = game.turn() === 'w' ? 'white' : 'black';
  let played;
  try { played = game.move(san); } catch (err) { played = null; }
  if (!played) throw new Error('That move is not legal.');
  return {
    game,
    turn,
    san: played.san,
    uci: played.from + played.to + (played.promotion || ''),
    fen: played.after,
    from: played.from,
    to: played.to,
    outcome: outcome(game)
  };
}

export function piecesOf(game) {
  const pieces = {};
  game.board().forEach((row) => row.forEach((cell) => {
    if (cell) pieces[cell.square] = { type: cell.type, color: cell.color };
  }));
  return pieces;
}

export function kingSquare(game) {
  if (!game.inCheck()) return '';
  const turn = game.turn();
  const pieces = piecesOf(game);
  return Object.keys(pieces).find((square) => pieces[square].type === 'k' && pieces[square].color === turn) || '';
}

function instant(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function clockView(state, nowMs) {
  if (!state || state.category === 'untimed') return { whiteMs: null, blackMs: null, flagged: null, dailyLeftMs: null };
  if (state.dailyDays) {
    const left = instant(state.deadlineAt) - nowMs;
    return {
      whiteMs: null,
      blackMs: null,
      flagged: left < 0 ? state.turn : null,
      dailyLeftMs: left < 0 ? 0 : left
    };
  }
  const elapsed = Math.max(0, nowMs - instant(state.clockAt));
  let whiteMs = Number(state.whiteMs);
  let blackMs = Number(state.blackMs);
  if (state.turn === 'white') whiteMs -= elapsed;
  if (state.turn === 'black') blackMs -= elapsed;
  if (state.turn === 'white' && whiteMs < 0) return { whiteMs: 0, blackMs, flagged: 'white', dailyLeftMs: null };
  if (state.turn === 'black' && blackMs < 0) return { whiteMs, blackMs: 0, flagged: 'black', dailyLeftMs: null };
  return { whiteMs, blackMs, flagged: null, dailyLeftMs: null };
}

export function formatClock(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return hours + ':' + String(minutes % 60).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }
  return minutes + ':' + String(seconds).padStart(2, '0');
}

export function formatSpan(ms) {
  if (ms == null) return '';
  if (ms >= 86400000) {
    const days = Math.max(1, Math.ceil(ms / 86400000));
    return days === 1 ? '1 day left' : days + ' days left';
  }
  if (ms >= 3600000) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return hours + 'h ' + minutes + 'm left';
  }
  return formatClock(ms) + ' left';
}

export const CHAT_SIZES = ['min', 'normal', 'max'];

export function chatStorageKey(profileId) {
  return 'chess.human.chatSize.' + (profileId || 'device');
}

export function loadChatSize(storage, profileId) {
  try {
    const value = storage.getItem(chatStorageKey(profileId));
    return CHAT_SIZES.includes(value) ? value : 'normal';
  } catch (err) {
    return 'normal';
  }
}

export function saveChatSize(storage, profileId, size) {
  const clean = CHAT_SIZES.includes(size) ? size : 'normal';
  storage.setItem(chatStorageKey(profileId), clean);
  return clean;
}

export function chatControls(size) {
  if (size === 'max') {
    return [
      { action: 'min', label: 'Minimize', tip: 'Minimize', glyph: '–' },
      { action: 'restore', label: 'Restore', tip: 'Restore', glyph: 'restore' }
    ];
  }
  if (size === 'min') return [{ action: 'restore', label: 'Restore', tip: 'Restore', glyph: 'restore' }];
  return [
    { action: 'min', label: 'Minimize', tip: 'Minimize', glyph: '–' },
    { action: 'max', label: 'Maximize', tip: 'Maximize', glyph: '□' }
  ];
}

export function unreadCount(size, seen, total) {
  if (size !== 'min') return 0;
  return Math.max(0, Number(total) - Number(seen || 0));
}

export function cleanChatBody(value) {
  const body = String(value || '').replace(/\r\n/g, '\n').trim();
  if (body.length < 1 || body.length > 500) throw new Error('A dialogue message must be 1 to 500 characters.');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(body)) throw new Error('A dialogue message must be 1 to 500 characters.');
  return body;
}
