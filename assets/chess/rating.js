export const RATING_CATEGORIES = ['bullet', 'blitz', 'rapid', 'daily', 'untimed'];

export function winGain(diff) {
  const d = Number(diff);
  if (d === 0) return 10;
  if (d > 0 && d <= 100) return 11;
  if (d > 100) return 11 + Math.ceil((d - 100) / 50);
  if (d < 0 && d >= -100) return 9;
  return Math.max(1, 9 - Math.ceil(((-d) - 100) / 50));
}

export function percentCeil(pool, percent) {
  return Math.floor((pool * percent + 99) / 100);
}

export function drawShares(whiteRating, blackRating) {
  const white = Number(whiteRating);
  const black = Number(blackRating);
  const pool = winGain(black - white) + winGain(white - black);
  let whitePercent = 20;
  let blackPercent = 80;
  if (white === black) {
    whitePercent = 15;
    blackPercent = 85;
  } else if (black < white) {
    whitePercent = 10;
    blackPercent = 90;
  }
  return {
    pool,
    white: percentCeil(pool, whitePercent),
    black: percentCeil(pool, blackPercent)
  };
}

export function ratingResult(result, whiteRating, blackRating) {
  const white = Number(whiteRating);
  const black = Number(blackRating);
  if (result === '1/2-1/2') {
    const shares = drawShares(white, black);
    return {
      white: { before: white, after: white + shares.white, delta: shares.white },
      black: { before: black, after: black + shares.black, delta: shares.black }
    };
  }
  const whiteWins = result === '1-0';
  const gain = winGain(whiteWins ? black - white : white - black);
  const winnerBefore = whiteWins ? white : black;
  const loserBefore = whiteWins ? black : white;
  const winner = { before: winnerBefore, after: winnerBefore + gain, delta: gain };
  const loserAfter = Math.max(0, loserBefore - (gain + 1));
  const loser = { before: loserBefore, after: loserAfter, delta: loserAfter - loserBefore };
  return whiteWins ? { white: winner, black: loser } : { white: loser, black: winner };
}

export function formatDelta(delta) {
  const value = Number(delta);
  if (value > 0) return '+' + value;
  return String(value);
}

export function puzzleScore(kind, userRating, puzzleRating, streakBefore) {
  const user = Number(userRating);
  const puzzle = Number(puzzleRating);
  const streak = Math.max(0, Number(streakBefore) || 0);
  if (kind === 'abandoned') return { gain: 0, bonus: 0, delta: 0, after: user, streakAfter: streak };
  if (kind === 'solved') {
    const gain = winGain(puzzle - user);
    const bonus = streak;
    return { gain, bonus, delta: gain + bonus, after: user + gain + bonus, streakAfter: streak + 1 };
  }
  const loss = winGain(user - puzzle) + 1;
  const after = Math.max(0, user - loss);
  return { gain: 0, bonus: 0, delta: after - user, after, streakAfter: 0, loss };
}
