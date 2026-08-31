// A review session. The scheduler sees one grade per card per day;
// a card graded Again is requeued within the session as practice
// until it comes out right, but those extra reps never touch memory
// state.

import { isNew, schedule, AGAIN, HARD, GOOD, EASY } from './fsrs.js';
import { dayOf } from './store.js';

// What is waiting right now: due reviews oldest-due first, then new
// cards up to the daily allowance.
export function buildQueue(state, now) {
  const entries = Object.values(state.templates).filter(e => !e.suspended);
  const due = entries
    .filter(e => !isNew(e.srs) && e.srs.due <= now)
    .sort((a, b) => a.srs.due - b.srs.due);
  const introducedToday = state.logs
    .filter(l => l.n && dayOf(l.t) === dayOf(now)).length;
  const allowance = Math.max(0, state.settings.newPerDay - introducedToday);
  const fresh = entries.filter(e => isNew(e.srs)).slice(0, allowance);
  return { due, fresh, queue: [...due, ...fresh] };
}

// Map what actually happened to an FSRS grade. Wrong is Again; right
// but leaning on hints or well past par is Hard; right and quick is
// Easy; otherwise Good.
export function gradeFor(ok, ms, hints, par) {
  if (!ok) return AGAIN;
  if (hints > 0 || ms > 1.5 * par * 1000) return HARD;
  if (ms <= 0.6 * par * 1000) return EASY;
  return GOOD;
}

export class Session {
  constructor(state, now) {
    const { queue } = buildQueue(state, now);
    this.state = state;
    this.items = queue.map(e => ({ entry: e, graded: false }));
    this.done = [];
    this.results = []; // {id, ok, ms, hints, grade, practice}
    this.startedAt = now;
  }

  get current() { return this.items[0] || null; }
  get remaining() { return this.items.length; }
  get total() { return this.done.length + this.items.length; }

  // Record one answered card. Returns the grade actually applied
  // (null for practice reps on an already-graded card).
  answer(ok, ms, hints, grade, now) {
    const item = this.items.shift();
    const e = item.entry;
    const practice = item.graded;
    let applied = null;
    if (!practice) {
      applied = grade;
      const first = isNew(e.srs);
      e.srs = schedule(e.srs, grade, now, this.state.settings.retention);
      this.state.logs.push({
        t: now, id: e.tpl.id, ok, ms, hints, grade,
        ...(first ? { n: 1 } : {}),
      });
    } else {
      this.state.logs.push({ t: now, id: e.tpl.id, ok, ms, hints, practice: 1 });
    }
    this.results.push({ id: e.tpl.id, ok, ms, hints, grade, practice });
    if (!ok || (!practice && grade === AGAIN)) {
      // come back a few cards later, already-graded, until it sticks
      const at = Math.min(3, this.items.length);
      this.items.splice(at, 0, { entry: e, graded: true });
    } else {
      this.done.push(item);
    }
    return applied;
  }

  summary() {
    const graded = this.results.filter(r => !r.practice);
    const right = graded.filter(r => r.ok).length;
    const bySkill = {};
    for (const r of graded) {
      const e = this.state.templates[r.id];
      for (const s of e.tpl.skills) {
        bySkill[s] = bySkill[s] || { right: 0, total: 0 };
        bySkill[s].total++;
        if (r.ok) bySkill[s].right++;
      }
    }
    return {
      graded: graded.length,
      right,
      minutes: graded.reduce((a, r) => a + r.ms, 0) / 60000,
      bySkill,
    };
  }
}
