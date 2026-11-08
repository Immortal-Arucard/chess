export const PALETTES = [
  { id: 'midnight', label: 'Midnight' },
  { id: 'classic', label: 'Classic' },
  { id: 'sea', label: 'Sea' },
  { id: 'paper', label: 'Paper' },
  { id: 'indigo', label: 'Indigo' }
];

export const PIECE_STYLES = [
  { id: 'line', label: 'Line' },
  { id: 'solid', label: 'Solid' },
  { id: 'outline', label: 'Outline' }
];

export const PIECE_COLORS = [
  { id: 'ink', label: 'Ink' },
  { id: 'ivory', label: 'Ivory' },
  { id: 'sky', label: 'Sky' }
];

export const ELO_MIN = 1320;
export const ELO_MAX = 3190;
export const ELO_CHOICES = [1320, 1600, 2000, 2500, 3190];
export const DEFAULT_ELO = 1600;
export const SEARCH_MS = 500;
export const PREF_KEY = 'chess.bot.preferences';

const PIECE_COLOR_VALUES = {
  ink: { lightFill: '#ffffff', lightStroke: '#111111', darkFill: '#111111', darkStroke: '#4fc3ff' },
  ivory: { lightFill: '#f4efe4', lightStroke: '#2a241c', darkFill: '#1c1612', darkStroke: '#f4efe4' },
  sky: { lightFill: '#4fc3ff', lightStroke: '#06202c', darkFill: '#e8f7ff', darkStroke: '#06202c' }
};

export function pieceColors(id) {
  return PIECE_COLOR_VALUES[id] || PIECE_COLOR_VALUES.ink;
}

export function clampElo(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_ELO;
  if (number < ELO_MIN) return ELO_MIN;
  if (number > ELO_MAX) return ELO_MAX;
  return Math.round(number);
}

export function strengthCommands(elo) {
  const applied = clampElo(elo);
  return [
    'setoption name UCI_LimitStrength value true',
    'setoption name UCI_Elo value ' + applied
  ];
}

export function defaultPrefs() {
  return { palette: 'midnight', pieceStyle: 'line', pieceColor: 'ink', elo: DEFAULT_ELO };
}

export function sanitizePrefs(value) {
  const prefs = defaultPrefs();
  if (!value || typeof value !== 'object') return prefs;
  if (PALETTES.some((item) => item.id === value.palette)) prefs.palette = value.palette;
  if (PIECE_STYLES.some((item) => item.id === value.pieceStyle)) prefs.pieceStyle = value.pieceStyle;
  if (PIECE_COLORS.some((item) => item.id === value.pieceColor)) prefs.pieceColor = value.pieceColor;
  if (ELO_CHOICES.includes(Number(value.elo))) prefs.elo = Number(value.elo);
  return prefs;
}

export function loadPrefs(storage) {
  try {
    return sanitizePrefs(JSON.parse(storage.getItem(PREF_KEY) || 'null'));
  } catch (err) {
    return defaultPrefs();
  }
}

export function savePrefs(storage, prefs) {
  const clean = sanitizePrefs(prefs);
  storage.setItem(PREF_KEY, JSON.stringify(clean));
  return clean;
}

export function strengthNote(elo) {
  const applied = clampElo(elo);
  return 'UCI_Elo ' + applied + '. Stockfish 19 Lite accepts ' + ELO_MIN + ' to ' + ELO_MAX + ' with UCI_LimitStrength. This is the engine limit, not a measured rating. Each move searches about 0.5 seconds.';
}
