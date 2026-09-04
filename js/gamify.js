// Streak freezes, badges, and records. Everything here is derived
// from the log so nothing can drift out of sync; the only stored
// state is the freeze bank and which badges have been celebrated.

import { dayOf } from './store.js';
import { isNew, retrievability } from './fsrs.js';

const DAY = 86400000;
export const FREEZE_CAP = 2;
export const FREEZE_EVERY = 7; // streak days per freeze earned

// Days with at least one real graded review.
function reviewDays(logs) {
  return new Set(logs.filter(l => l.id && !l.practice).map(l => dayOf(l.t)));
}

// A freeze quietly covers a missed day so one bad Tuesday does not
// zero a month of work. Called at boot; returns how many were spent.
export function applyFreezes(state, now) {
  const g = state.gamify;
  const days = reviewDays(state.logs);
  for (const d of g.frozenDays) days.add(d);
  if (days.size === 0) return 0;
  const gap = [];
  let cursor = now - DAY;
  while (!days.has(dayOf(cursor))) {
    gap.push(dayOf(cursor));
    cursor -= DAY;
    if (gap.length > FREEZE_CAP + 1) return 0; // gap too wide, streak is gone
  }
  if (!gap.length || gap.length > g.freezes) return 0;
  g.freezes -= gap.length;
  g.frozenDays.push(...gap);
  return gap.length;
}

// Streak, counting frozen days as alive.
export function streakWithFreezes(state, now) {
  const days = reviewDays(state.logs);
  for (const d of state.gamify.frozenDays) days.add(d);
  let count = 0;
  let cursor = now;
  if (!days.has(dayOf(cursor))) cursor -= DAY;
  while (days.has(dayOf(cursor))) { count++; cursor -= DAY; }
  return count;
}

// Every FREEZE_EVERY consecutive days banks one freeze, capped.
// Returns how many were just earned.
export function earnFreezes(state, streak) {
  const g = state.gamify;
  const level = Math.floor(streak / FREEZE_EVERY);
  if (streak < g.earnedFreezes * FREEZE_EVERY) g.earnedFreezes = level; // streak broke; rebaseline
  if (level <= g.earnedFreezes) return 0;
  const granted = Math.min(level - g.earnedFreezes, FREEZE_CAP - g.freezes);
  g.earnedFreezes = level;
  if (granted <= 0) return 0;
  g.freezes += granted;
  return granted;
}

export function longestStreak(state) {
  const days = [...reviewDays(state.logs), ...state.gamify.frozenDays]
    .map(d => Date.parse(`${d}T12:00:00`)).sort((a, b) => a - b);
  let best = 0, run = 0, prev = 0;
  for (const t of days) {
    run = prev && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

// ---------- exam readiness ----------

// For every deck with a future exam: the mean predicted recall on
// exam day across its studied cards, straight from the memory model.
// The honest number, not the vibes number.
export function examReadiness(state, now) {
  const out = [];
  for (const [deckId, exam] of Object.entries(state.settings.exams || {})) {
    if (exam <= now) continue;
    let sum = 0, seen = 0, unseen = 0;
    for (const e of Object.values(state.templates)) {
      if (e.deckId !== deckId || e.suspended) continue;
      if (isNew(e.srs)) { unseen++; continue; }
      sum += retrievability(e.srs, exam);
      seen++;
    }
    out.push({
      deckId, exam,
      days: Math.ceil((exam - now) / DAY),
      ready: seen ? sum / seen : 0,
      seen, unseen,
    });
  }
  return out.sort((a, b) => a.exam - b.exam);
}

// ---------- badges ----------

function perDay(logs) {
  const map = new Map();
  for (const l of logs) {
    if (!l.id || l.practice) continue;
    const d = dayOf(l.t);
    const row = map.get(d) || { n: 0, right: 0 };
    row.n++;
    if (l.ok) row.right++;
    map.set(d, row);
  }
  return map;
}

export const BADGES = [
  { id: 'day-one', name: 'day one', desc: 'your first review',
    test: c => c.days.size >= 1 },
  { id: 'streak-3', name: 'three days', desc: 'a 3-day streak',
    test: c => c.streak >= 3 || c.longest >= 3 },
  { id: 'streak-7', name: 'one week', desc: 'a 7-day streak',
    test: c => c.streak >= 7 || c.longest >= 7 },
  { id: 'streak-14', name: 'fortnight', desc: 'a 14-day streak',
    test: c => c.streak >= 14 || c.longest >= 14 },
  { id: 'streak-30', name: 'monk mode', desc: 'a 30-day streak',
    test: c => c.streak >= 30 || c.longest >= 30 },
  { id: 'streak-100', name: 'the hundred', desc: 'a 100-day streak',
    test: c => c.streak >= 100 || c.longest >= 100 },
  { id: 'reviews-100', name: 'century', desc: '100 reviews',
    test: c => c.total >= 100 },
  { id: 'reviews-500', name: 'five hundred', desc: '500 reviews',
    test: c => c.total >= 500 },
  { id: 'clean-sweep', name: 'clean sweep', desc: '10+ reviews in a day, none wrong',
    test: c => [...c.days.values()].some(d => d.n >= 10 && d.right === d.n) },
  { id: 'deep-work', name: 'deep work', desc: 'a 50-minute lock in',
    test: c => c.state.logs.some(l => l.lock >= 50) },
  { id: 'card-author', name: 'card author', desc: '10 cards of your own',
    test: c => Object.values(c.state.templates).filter(e => e.custom).length >= 10 },
  { id: 'comeback', name: 'the comeback', desc: 'returned after 3+ days away',
    test: c => {
      const days = [...c.days.keys()].map(d => Date.parse(`${d}T12:00:00`)).sort((a, b) => a - b);
      for (let i = 1; i < days.length; i++) {
        if (Math.round((days[i] - days[i - 1]) / DAY) >= 3) return true;
      }
      return false;
    } },
  { id: 'brain-dump', name: 'memory, unassisted', desc: 'a brain dump, done honestly',
    test: c => c.state.logs.some(l => l.dump) },
];

export function badgeContext(state, now, streak) {
  const days = perDay(state.logs);
  return {
    state, now, streak, days,
    longest: longestStreak(state),
    total: state.logs.filter(l => l.id && !l.practice).length,
  };
}

// Earned badge ids, plus which are newly earned since last look.
export function checkBadges(state, now, streak) {
  const ctx = badgeContext(state, now, streak);
  const earned = BADGES.filter(b => b.test(ctx)).map(b => b.id);
  const fresh = earned.filter(id => !state.gamify.seenBadges.includes(id));
  state.gamify.seenBadges.push(...fresh);
  return { earned, fresh };
}
