import { Chess, DEFAULT_POSITION } from '../vendor/chess.js/chess.js';

export const STANDARD_FEN = DEFAULT_POSITION;

export const DEVICE_RECOVERY_KEY = 'chess.bot.deviceRecovery';

export function deviceRecoveryRecord(snapshot) {
  return {
    kind: 'device-recovery',
    accountSave: false,
    note: 'On this device only. Not an account save.',
    phase: snapshot.phase,
    startFen: snapshot.startFen,
    sans: snapshot.sans || [],
    player: snapshot.player,
    manualResult: snapshot.manualResult || null,
    clientGameId: snapshot.clientGameId,
    record: snapshot.record || null,
    discardedIds: snapshot.discardedIds || [],
    savedStatus: snapshot.savedStatus || 'unsaved',
    accountId: snapshot.accountId || null,
    ownerAtStart: snapshot.ownerAtStart || null,
    prefs: snapshot.prefs || null
  };
}

export function rememberDeviceRecovery(storage, snapshot) {
  const recovery = deviceRecoveryRecord(snapshot);
  storage.setItem(DEVICE_RECOVERY_KEY, JSON.stringify(recovery));
  return recovery;
}

export function readDeviceRecovery(storage) {
  try {
    const value = JSON.parse(storage.getItem(DEVICE_RECOVERY_KEY) || 'null');
    if (!value || value.kind !== 'device-recovery' || value.accountSave !== false) return null;
    if (value.clientGameId && (value.discardedIds || []).includes(value.clientGameId)) return null;
    return value;
  } catch (err) {
    return null;
  }
}

export const ACCOUNT_SAVE_UNAVAILABLE =
  'Saving to a Chess account is not available yet. This game is still unsaved. The full move record stays on this page until you discard it or leave after discarding. Download the PGN if you want a copy. A PGN download is not an account save.';

export function accountSaveService() {
  return {
    live: false,
    reason: ACCOUNT_SAVE_UNAVAILABLE
  };
}

export function loadAutoSavePreference(account) {
  try {
    if (!account || account.available !== true || typeof account.id !== 'string' || !account.id) {
      return { available: false, enabled: false, accountId: null };
    }
    if (account.settingsError) {
      return { available: false, enabled: false, accountId: null, error: String(account.settingsError) };
    }
    return {
      available: true,
      enabled: account.autoSaveBotResults === true,
      accountId: account.id
    };
  } catch (err) {
    return { available: false, enabled: false, accountId: null };
  }
}

export function accountSettingsView(account) {
  const preference = loadAutoSavePreference(account);
  if (!preference.available || !accountSaveService().live) {
    return {
      checked: false,
      disabled: true,
      note: 'Automatically save bot-game results is an account setting. It is off by default and is stored with the Chess account, not on this device. Chess accounts are not available yet, so it cannot be turned on. When it is on, each finished bot game is saved once with every move, not only the outcome. Until then, finished games stay unsaved unless you later save them to an account.'
    };
  }
  return {
    checked: preference.enabled,
    disabled: false,
    note: preference.enabled
      ? 'Finished bot games are saved to this account automatically, including every move.'
      : 'Automatic saving is off. Use Save to account after a game if you want to keep every move.'
  };
}

function headerPairs(headers) {
  const pairs = [];
  Object.keys(headers).forEach((key) => {
    pairs.push(key, headers[key]);
  });
  return pairs;
}

export function buildGameRecord(input) {
  const startFen = input.startFen || STANDARD_FEN;
  const game = new Chess();
  if (startFen !== STANDARD_FEN) game.load(startFen);
  const sans = input.sans || [];
  sans.forEach((san) => {
    const played = game.move(san);
    if (!played) throw new Error('Illegal move in game record: ' + san);
  });
  const verbose = game.history({ verbose: true });
  const moves = verbose.map((move, index) => ({
    ply: index + 1,
    san: move.san,
    uci: move.from + move.to + (move.promotion || ''),
    fen: move.after
  }));
  const headers = {
    Event: input.event || 'Bot chess',
    Site: input.site || '',
    Date: input.date || '????.??.??',
    Round: '1',
    White: input.white || '?',
    Black: input.black || '?',
    Result: input.result || '*',
    Termination: input.termination || '',
    PlayerColor: input.playerColor || '',
    Opponent: input.opponentName || 'Stockfish 19 Lite',
    OpponentUCIElo: String(input.opponentUciElo || ''),
    RatingKind: 'uncalibrated engine limit',
    Rated: 'false'
  };
  if (startFen !== STANDARD_FEN) {
    headers.SetUp = '1';
    headers.FEN = startFen;
  }
  game.header(...headerPairs(headers));
  const pgn = game.pgn();
  const record = {
    id: input.id,
    pgn,
    startFen,
    result: headers.Result,
    termination: headers.Termination,
    playerColor: headers.PlayerColor,
    opponentName: headers.Opponent,
    opponentUciElo: input.opponentUciElo,
    rated: false,
    white: headers.White,
    black: headers.Black,
    finalFen: game.fen(),
    moves,
    boundAccountId: input.boundAccountId || null
  };
  Object.freeze(record.moves);
  record.moves.forEach((move) => Object.freeze(move));
  return Object.freeze(record);
}

export function replayRecord(record) {
  const game = new Chess();
  game.loadPgn(record.pgn);
  const headers = game.getHeaders();
  const verbose = game.history({ verbose: true });
  return {
    sans: verbose.map((move) => move.san),
    uci: verbose.map((move) => move.from + move.to + (move.promotion || '')),
    fens: verbose.map((move) => move.after),
    finalFen: game.fen(),
    result: headers.Result || '*',
    startFen: headers.FEN || STANDARD_FEN,
    headers
  };
}

export function recordReplayErrors(record) {
  const errors = [];
  if (!record || typeof record.pgn !== 'string' || !record.pgn.trim()) errors.push('missing pgn');
  if (!record || !Array.isArray(record.moves)) errors.push('missing moves');
  if (errors.length) return errors;
  let replay;
  try {
    replay = replayRecord(record);
  } catch (err) {
    return ['pgn did not replay'];
  }
  if (replay.sans.length !== record.moves.length) errors.push('ply count');
  record.moves.forEach((move, index) => {
    if (!replay.sans[index] || replay.sans[index] !== move.san) errors.push('san ' + (index + 1));
    if (replay.uci[index] !== move.uci) errors.push('uci ' + (index + 1));
    if (replay.fens[index] !== move.fen) errors.push('fen ' + (index + 1));
  });
  if (replay.finalFen !== record.finalFen) errors.push('final position');
  if (replay.result !== record.result) errors.push('result');
  if ((record.startFen || STANDARD_FEN) !== replay.startFen) errors.push('starting position');
  if (record.moves.length > 0 && !/\d+\./.test(record.pgn)) errors.push('summary only');
  return errors;
}

export function createResultBook() {
  const discarded = new Set();
  const saved = new Set();
  const posts = [];
  return {
    noteDiscard(id) {
      if (id) discarded.add(id);
    },
    wasDiscarded(id) {
      return discarded.has(id);
    },
    posts,
    savedCount() {
      return saved.size;
    }
  };
}

export function applySave(kind, account, preference, record, book) {
  const service = accountSaveService();
  const kept = record;
  if (!kept || recordReplayErrors(kept).length) {
    return { status: 'unsaved', outcome: 'invalid', record: kept, error: 'This game record is incomplete, so it was not saved.', accountId: null };
  }
  if (book && book.wasDiscarded(kept.id)) {
    return {
      status: 'unsaved',
      outcome: 'discarded-not-replayed',
      record: kept,
      error: 'This game was discarded. It is not saved, and turning on automatic saving does not save it later.',
      accountId: null
    };
  }
  if (kept.boundAccountId && account && account.id && kept.boundAccountId !== account.id) {
    return {
      status: 'unsaved',
      outcome: 'wrong-account',
      record: kept,
      error: 'The signed-in account changed. This game was not saved to the new account.',
      accountId: null
    };
  }
  if (service.live === true) {
    return {
      status: 'unsaved',
      outcome: 'error',
      record: kept,
      error: 'The account service reported itself live without a Chess save request. The game was not saved.',
      accountId: null
    };
  }
  return {
    status: 'unsaved',
    outcome: 'unavailable',
    record: kept,
    error: service.reason || ACCOUNT_SAVE_UNAVAILABLE,
    accountId: null,
    kind: kind || 'manual',
    preferenceSeen: preference ? preference.enabled === true : false
  };
}
