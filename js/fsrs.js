// FSRS-4.5 scheduler with the published default weights.
// One grade per card per day reaches this file; same-day repeats are
// practice and never touch memory state.

export const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975,
  0.0310, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.5870,
  0.2272, 2.8755];
const DECAY = -0.5;
const FACTOR = 19 / 81;
const DAY = 86400000;
const MAX_INTERVAL = 1095; // three years is far enough out

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function newState() {
  return { due: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, last: 0 };
}

export function isNew(s) { return s.reps === 0; }

// Probability of recall after t days at stability S.
export function retrievability(s, now) {
  if (isNew(s) || !s.last) return 0;
  const t = Math.max(0, (now - s.last) / DAY);
  return Math.pow(1 + FACTOR * t / s.stability, DECAY);
}

function initStability(grade) {
  return Math.max(W[grade - 1], 0.1);
}

function initDifficulty(grade) {
  return clamp(W[4] - (grade - 3) * W[5], 1, 10);
}

function nextDifficulty(d, grade) {
  const next = d - W[6] * (grade - 3);
  return clamp(W[7] * W[4] + (1 - W[7]) * next, 1, 10);
}

function recallStability(d, s, r, grade) {
  const hard = grade === HARD ? W[15] : 1;
  const easy = grade === EASY ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) *
    (Math.exp(W[10] * (1 - r)) - 1) * hard * easy);
}

function forgetStability(d, s, r) {
  const next = W[11] * Math.pow(d, -W[12]) *
    (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  return Math.min(next, s);
}

export function interval(stability, retention) {
  const days = stability / FACTOR * (Math.pow(retention, 1 / DECAY) - 1);
  return clamp(Math.round(days), 1, MAX_INTERVAL);
}

// Apply one grade. Returns a fresh state; never mutates.
export function schedule(s, grade, now, retention = 0.9) {
  const n = { ...s };
  if (isNew(s)) {
    n.stability = initStability(grade);
    n.difficulty = initDifficulty(grade);
  } else {
    const r = retrievability(s, now);
    n.difficulty = nextDifficulty(s.difficulty, grade);
    n.stability = grade === AGAIN
      ? forgetStability(s.difficulty, s.stability, r)
      : recallStability(s.difficulty, s.stability, r, grade);
    if (grade === AGAIN) n.lapses = s.lapses + 1;
  }
  n.reps = s.reps + 1;
  n.last = now;
  n.due = now + interval(n.stability, retention) * DAY;
  return n;
}
