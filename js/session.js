// A review session. The scheduler sees one grade per card per day;
// a card graded Again is requeued within the session as practice
// until it comes out right, but those extra reps never touch memory
// state.

import { isNew, schedule, retrievability, AGAIN, HARD, GOOD, EASY } from './fsrs.js';
import { dayOf } from './store.js';

// Round-robin across skills so no two same-skill cards sit together.
// Mixed practice is harder and slower than blocked runs of one type,
// and it is what transfers to exams (Rohrer and Taylor's result).
export function interleave(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = e.tpl.skills[0] || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const lists = [...groups.values()];
  const out = [];
  for (let i = 0; out.length < entries.length; i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}

// What is waiting right now: due reviews before new cards, each set
// interleaved across skills.
export function buildQueue(state, now) {
  const entries = Object.values(state.templates).filter(e => !e.suspended);
  const due = interleave(entries
    .filter(e => !isNew(e.srs) && e.srs.due <= now)
    .sort((a, b) => a.srs.due - b.srs.due));
  const introducedToday = state.logs
    .filter(l => l.n && dayOf(l.t) === dayOf(now)).length;
  const allowance = Math.max(0, state.settings.newPerDay - introducedToday);
  const fresh = interleave(entries.filter(e => isNew(e.srs)).slice(0, allowance));
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

// A card lapsing over and over is a badly written card, not a badly
// studied one. Flag it instead of grinding it.
export const LEECH_LAPSES = 4;

export class Session {
  constructor(state, now) {
    const { queue } = buildQueue(state, now);
    this.state = state;
    this.items = queue.map(e => ({ entry: e, graded: false }));
    this.done = [];
    this.results = []; // {id, ok, ms, hints, grade, practice}
    this.startedAt = now;
    this.lastUndo = null;
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
    this.leech = false;
    if (!practice) {
      applied = grade;
      const first = isNew(e.srs);
      const prevSrs = e.srs;
      e.srs = schedule(e.srs, grade, now, this.state.settings.retention);
      // an exam date caps the interval: nothing schedules past it
      const exam = this.state.settings.exams?.[e.deckId];
      if (exam && now < exam && e.srs.due > exam) e.srs = { ...e.srs, due: exam };
      this.state.logs.push({
        t: now, id: e.tpl.id, ok, ms, hints, grade,
        ...(first ? { n: 1 } : {}),
      });
      this.leech = grade === AGAIN && e.srs.lapses >= LEECH_LAPSES;
      this.lastUndo = {
        entry: e, prevSrs,
        logIndex: this.state.logs.length - 1,
        resultIndex: this.results.length,
        requeued: !ok || grade === AGAIN,
        donePushed: ok && grade !== AGAIN,
      };
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

  // Take back the most recent graded answer: memory state, log, and
  // queue position are all restored, and the card is asked again.
  undo() {
    const u = this.lastUndo;
    if (!u) return false;
    u.entry.srs = u.prevSrs;
    this.state.logs.splice(u.logIndex, 1);
    this.results.splice(u.resultIndex, 1);
    if (u.requeued) {
      const i = this.items.findIndex(it => it.graded && it.entry === u.entry);
      if (i >= 0) this.items.splice(i, 1);
    }
    if (u.donePushed) {
      const i = this.done.findIndex(it => it.entry === u.entry);
      if (i >= 0) this.done.splice(i, 1);
    }
    this.items.unshift({ entry: u.entry, graded: false });
    this.lastUndo = null;
    return true;
  }

  // Lock-in mode: when the queue runs dry with time on the clock,
  // pull the weakest seen cards back in as practice.
  refill(now, n = 5) {
    const queued = new Set(this.items.map(i => i.entry.tpl.id));
    const pool = Object.values(this.state.templates)
      .filter(e => !e.suspended && !isNew(e.srs) && !queued.has(e.tpl.id))
      .sort((a, b) => retrievability(a.srs, now) - retrievability(b.srs, now))
      .slice(0, n);
    for (const e of pool) this.items.push({ entry: e, graded: true, extra: true });
    return pool.length;
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
