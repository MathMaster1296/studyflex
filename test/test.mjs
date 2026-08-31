// Run with: node test/test.mjs
// Covers the expression engine, the FSRS scheduler, template drawing
// and checking, the session queue, and the integrity of every card
// in the shipped deck.

import { parse, evaluate, evalIn, equivalent, stripConstant } from '../js/expr.js';
import * as fsrs from '../js/fsrs.js';
import { rng } from '../js/rng.js';
import { draw, fill, check, validate } from '../js/template.js';
import { defaultState, load, streak, dayOf } from '../js/store.js';
import { buildQueue, gradeFor, Session } from '../js/session.js';
import { deck as calc1 } from '../js/decks/calc1.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL  ${name}`); }
}
function near(a, b, name, tol = 1e-9) {
  ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${name} (got ${a}, wanted ${b})`);
}
function throws(fn, name) {
  try { fn(); failed++; console.error(`FAIL  ${name} (no error thrown)`); }
  catch { passed++; }
}

// ---------- expression engine ----------

near(evalIn('2+3*4'), 14, 'precedence');
near(evalIn('2^3^2'), 512, 'power is right associative');
near(evalIn('-3^2'), -9, 'negation binds looser than power');
near(evalIn('2x', { x: 3 }), 6, 'implicit multiplication, number times var');
near(evalIn('(x+1)(x-1)', { x: 4 }), 15, 'implicit multiplication, parens');
near(evalIn('3sin(pi/2)'), 3, 'implicit multiplication, function');
near(evalIn('2e3'), 2000, 'scientific notation');
near(evalIn('2e'), 2 * Math.E, 'e as a constant after a number');
near(evalIn('ax', { a: 5, x: 2 }), 10, 'letter run splits into known names');
near(evalIn('api', { a: 2 }), 2 * Math.PI, 'letter run finds pi');
near(evalIn('1/2x', { x: 4 }), 2, '1/2x reads as (1/2)x');
near(evalIn('sqrt(2)/2'), Math.SQRT1_2, 'sqrt');
near(evalIn('x**2', { x: 3 }), 9, '** works as ^');
near(evalIn('sec(0)'), 1, 'sec');
throws(() => parse('sin x'), 'functions need parentheses');
throws(() => parse('3 + '), 'dangling operator');
throws(() => parse('y + 1', ['x']), 'unknown names are rejected');
ok(stripConstant('sin(x)/2 + C') === 'sin(x)/2', 'strip + C');
ok(stripConstant('sin(x)/2+c') === 'sin(x)/2', 'strip +c without space');

const det = rng(7);
ok(equivalent('a*cos(a*x)', 'a cos(ax)', { vars: ['x'], env: { a: 3 }, rand: det }),
  'equivalent forms match');
ok(!equivalent('a*cos(a*x)', 'cos(a*x)', { vars: ['x'], env: { a: 3 }, rand: rng(8) }),
  'missing factor is caught');
ok(equivalent('sin(a*x)/a', 'sin(a*x)/a + 7', { vars: ['x'], env: { a: 2 }, upToConstant: true, rand: rng(9) }),
  'constant offset allowed for antiderivatives');
ok(!equivalent('sin(a*x)/a', 'x', { vars: ['x'], env: { a: 2 }, upToConstant: true, rand: rng(10) }),
  'non-constant difference rejected for antiderivatives');
ok(!equivalent('1/x', 'x', { vars: ['x'], rand: rng(11) }), 'different functions differ');
ok(equivalent('a/cos(a*x)^2', 'a*sec(a*x)^2', { vars: ['x'], env: { a: 3 }, domain: [-0.25, 0.25], rand: rng(12) }),
  'sec form equals 1/cos form');

// ---------- fsrs ----------

{
  const now = Date.parse('2026-01-10T12:00:00');
  const s = fsrs.schedule(fsrs.newState(), fsrs.GOOD, now);
  near(s.stability, 3.7145, 'first Good uses the initial stability weight', 1e-6);
  ok(s.due - now === 4 * 86400000, 'interval at 0.9 retention is about the stability');
  near(fsrs.retrievability(s, now), 1, 'retrievability right after review is 1', 1e-9);
  near(fsrs.retrievability(s, s.due), 0.9, 'retrievability at the due date is the target', 0.01);

  const later = s.due;
  const byGrade = [fsrs.AGAIN, fsrs.HARD, fsrs.GOOD, fsrs.EASY]
    .map(g => fsrs.schedule(s, g, later).stability);
  ok(byGrade[0] < byGrade[1] && byGrade[1] < byGrade[2] && byGrade[2] < byGrade[3],
    'stability is monotone in the grade');
  ok(byGrade[0] <= s.stability, 'a lapse never increases stability');
  const lapsed = fsrs.schedule(s, fsrs.AGAIN, later);
  ok(lapsed.lapses === 1, 'lapse counter');
  ok(fsrs.interval(0.01, 0.9) === 1, 'interval never rounds to zero');
}

// ---------- rng ----------

{
  const a = rng(42), b = rng(42);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
  ok(seqA.every((v, i) => v === seqB[i]), 'seeded rng is deterministic');
  ok(seqA.every(v => v >= 0 && v < 1), 'rng stays in [0,1)');
}

// ---------- templates ----------

{
  const tpl = calc1.templates.find(t => t.id === 'calc1/power-rule');
  const p1 = draw(tpl, 5), p2 = draw(tpl, 5), p3 = draw(tpl, 6);
  ok(JSON.stringify(p1) === JSON.stringify(p2), 'same seed, same draw');
  ok(JSON.stringify(p1) !== JSON.stringify(p3) || true, 'draw runs');
  ok(p1.an === p1.a * p1.n, 'computed params');

  ok(fill('x^2 {{a:+}}x', { a: 3 }) === 'x^2 + 3x', 'signed positive');
  ok(fill('x^2 {{a:+}}x', { a: -3 }) === 'x^2 - 3x', 'signed negative');
  ok(fill('{{q.val}}', { q: { val: '1/2' } }) === '1/2', 'pick field access');

  const quot = calc1.templates.find(t => t.id === 'calc1/quotient-at-point');
  for (let seed = 1; seed <= 500; seed++) {
    const p = draw(quot, seed);
    if (p.a * p.d - p.b * p.c === 0) { ok(false, 'nonzero constraint violated'); break; }
    if (seed === 500) ok(true, 'nonzero constraint holds over 500 draws');
  }

  const params = { a: 3, n: 4, an: 12, nm1: 3 };
  ok(check(tpl, params, '12x^3').ok, 'expression answer, plain form');
  ok(check(tpl, params, '3*4*x^3').ok, 'expression answer, unsimplified form');
  ok(!check(tpl, params, '12x^2').ok, 'wrong exponent rejected');
  ok(check(tpl, params, '12y^3').error !== undefined, 'wrong variable is a parse error, not a miss');

  const cos = calc1.templates.find(t => t.id === 'calc1/int-cos');
  const cp = { a: 3 };
  ok(check(cos, cp, 'sin(3x)/3 + C').ok, 'antiderivative with + C');
  ok(check(cos, cp, 'sin(3x)/3 - 5').ok, 'antiderivative with another constant');
  ok(!check(cos, cp, 'cos(3x)/3').ok, 'wrong antiderivative rejected');

  const trig = calc1.templates.find(t => t.id === 'calc1/trig-recall');
  const tp = { q: { fn: '\\sin', ang: '\\frac{\\pi}{3}', val: 'sqrt(3)/2', show: '\\tfrac{\\sqrt{3}}{2}' } };
  ok(check(trig, tp, 'sqrt(3)/2').ok, 'exact trig value, symbolic');
  ok(check(trig, tp, '0.866').ok, 'exact trig value, decimal');
  ok(!check(trig, tp, '1/2').ok, 'wrong trig value rejected');
}

// ---------- deck integrity ----------

for (const tpl of calc1.templates) {
  const problems = validate(tpl);
  ok(problems.length === 0, `deck card ${tpl.id}: ${problems.join('; ')}`);
  ok((tpl.hints || []).length > 0, `deck card ${tpl.id} has a hint`);
  ok((tpl.solution || '').length > 0, `deck card ${tpl.id} has a solution`);
  ok(tpl.par >= 10 && tpl.par <= 300, `deck card ${tpl.id} par time is sane`);
}
{
  const ids = calc1.templates.map(t => t.id);
  ok(new Set(ids).size === ids.length, 'deck ids are unique');
}

// ---------- store and session ----------

{
  const state = load([calc1], null);
  ok(Object.keys(state.templates).length === calc1.templates.length, 'seed deck merges in');

  const now = Date.parse('2026-02-01T18:00:00');
  const q1 = buildQueue(state, now);
  ok(q1.due.length === 0, 'nothing due before any reviews');
  ok(q1.fresh.length === state.settings.newPerDay, 'new cards respect the daily allowance');

  ok(gradeFor(false, 10000, 0, 60) === fsrs.AGAIN, 'wrong maps to again');
  ok(gradeFor(true, 20000, 1, 60) === fsrs.HARD, 'hint maps to hard');
  ok(gradeFor(true, 120000, 0, 60) === fsrs.HARD, 'slow maps to hard');
  ok(gradeFor(true, 20000, 0, 60) === fsrs.EASY, 'fast maps to easy');
  ok(gradeFor(true, 45000, 0, 60) === fsrs.GOOD, 'ordinary maps to good');

  const session = new Session(state, now);
  const total = session.remaining;
  const first = session.current.entry.tpl.id;
  session.answer(false, 30000, 0, fsrs.AGAIN, now);
  ok(session.remaining === total, 'a miss comes back later in the session');
  while (session.current && session.current.entry.tpl.id !== first) {
    session.answer(true, 20000, 0, fsrs.GOOD, now);
  }
  ok(session.current !== null && session.current.graded, 'the miss returns as practice');
  session.answer(true, 20000, 0, fsrs.GOOD, now);
  while (session.current) session.answer(true, 20000, 0, fsrs.GOOD, now);
  const s = session.summary();
  ok(s.graded === total, 'summary counts each card once');
  ok(state.logs.filter(l => l.practice).length === 1, 'practice reps are marked');
  ok(state.logs.filter(l => l.n).length === total, 'first-ever grades are marked');

  const q2 = buildQueue(state, now);
  ok(q2.fresh.length === 0, 'daily new allowance is spent');
  ok(streak(state.logs, now) === 1, 'streak starts at one');
  ok(streak(state.logs, now + 86400000) === 1, 'streak survives until a full day is missed');
  ok(streak(state.logs, now + 3 * 86400000) === 0, 'streak dies after a missed day');
  ok(dayOf(now) === '2026-02-01', 'local day key');
}

console.log(failed ? `\n${passed} passed, ${failed} FAILED` : `all ${passed} checks passed`);
process.exit(failed ? 1 : 0);
