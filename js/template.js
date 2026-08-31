// Templates: drawing parameters, filling prompts, checking answers,
// and validating cards. Pure logic; the app and the tests both use it.

import { parse, evaluate, evalIn, equivalent, stripConstant } from './expr.js';
import { rng } from './rng.js';

// ---------- drawing parameters ----------

// Param specs, in insertion order:
//   {type:'int', min, max, ne:[...]}          integer, optionally excluding values
//   {type:'float', min, max, dp}              rounded to dp decimals (default 1)
//   {type:'pick', from:[...]}                 one record from a list
//   {type:'computed', expr:'a*b'}             derived from earlier params
// The optional template.nonzero list holds expressions that must not
// draw to zero, e.g. 'a*d - b*c'.

export function draw(template, seed) {
  const rand = rng(seed);
  for (let attempt = 0; attempt < 200; attempt++) {
    const params = {};
    for (const [name, spec] of Object.entries(template.params || {})) {
      if (spec.type === 'int') {
        let v;
        do { v = spec.min + Math.floor(rand() * (spec.max - spec.min + 1)); }
        while (spec.ne && spec.ne.includes(v));
        params[name] = v;
      } else if (spec.type === 'float') {
        const dp = spec.dp ?? 1;
        const v = spec.min + rand() * (spec.max - spec.min);
        params[name] = Number(v.toFixed(dp));
      } else if (spec.type === 'pick') {
        params[name] = spec.from[Math.floor(rand() * spec.from.length)];
      } else if (spec.type === 'computed') {
        params[name] = evalIn(spec.expr, flat(params));
      } else {
        throw new Error(`param ${name}: unknown type "${spec.type}"`);
      }
    }
    const ok = (template.nonzero || []).every(ex =>
      Math.abs(evalIn(ex, flat(params))) > 1e-12);
    if (ok) return params;
  }
  throw new Error(`card "${template.id}": could not satisfy nonzero constraints`);
}

// pick params are records; flatten q.val style access for the evaluator.
function flat(params) {
  const env = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'number') env[k] = v;
  }
  return env;
}

// ---------- substitution ----------

// {{name}} inserts the value, {{name:+}} inserts it with a leading
// sign ("+ 3" / "- 3"), {{q.field}} reaches into a pick record.
export function fill(text, params) {
  return String(text).replace(/\{\{(\w+)(?:\.(\w+))?(?::(\+))?\}\}/g,
    (m, name, field, signed) => {
      let v = params[name];
      if (v === undefined) throw new Error(`no param "${name}" for ${m}`);
      if (field !== undefined) {
        v = v[field];
        if (v === undefined) throw new Error(`param "${name}" has no field "${field}"`);
      }
      if (signed) {
        const n = Number(v);
        return n < 0 ? `- ${fmt(-n)}` : `+ ${fmt(n)}`;
      }
      return typeof v === 'number' ? fmt(v) : String(v);
    });
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

// ---------- checking ----------

// Returns {ok} on a gradable answer, or {error} when the input
// could not be read (a parse error is not an attempt).
export function check(template, params, input) {
  const a = template.answer;
  const env = flat(params);
  try {
    if (a.type === 'number') {
      const expected = evalIn(fill(a.expr, params), env);
      const got = evalIn(input);
      const tol = a.tol ?? 1e-3;
      return { ok: Math.abs(got - expected) <= tol * Math.max(1, Math.abs(expected)) };
    }
    if (a.type === 'expression') {
      const user = a.upToConstant ? stripConstant(input) : input;
      if (!user.trim()) return { error: 'type an expression' };
      return {
        ok: equivalent(fill(a.expr, params), user, {
          vars: a.vars, env, domain: a.domain,
          upToConstant: a.upToConstant, rand: Math.random,
        }),
      };
    }
    if (a.type === 'choice') {
      return { ok: Number(input) === a.correct };
    }
    if (a.type === 'self') {
      return { ok: input === 'yes' };
    }
    return { error: `unknown answer type "${a.type}"` };
  } catch (e) {
    if (e.parse) return { error: e.message };
    throw e;
  }
}

// The reference answer, ready to render (display override, else the
// raw expression), with params filled in.
export function referenceText(template, params) {
  const a = template.answer;
  if (a.display) return fill(a.display, params);
  if (a.type === 'choice') return fill(a.options[a.correct], params);
  if (a.expr) return `\\mathtt{${fill(a.expr, params).replace(/\*/g, '\\cdot ')}}`;
  return '';
}

// ---------- validation ----------

// Draw a card many times and make sure its own reference answer
// passes its own checker. The editor runs this on save and the test
// suite runs it over the whole seed deck, so a card that cannot
// grade itself never reaches a session.
export function validate(template) {
  const problems = [];
  const need = ['id', 'name', 'prompt', 'answer'];
  for (const k of need) if (!template[k]) problems.push(`missing ${k}`);
  if (!Array.isArray(template.skills) || !template.skills.length) {
    problems.push('needs at least one skill tag');
  }
  if (problems.length) return problems;

  const a = template.answer;
  for (let seed = 1; seed <= 100; seed++) {
    let params;
    try { params = draw(template, seed); } catch (e) { return [e.message]; }
    try {
      fill(template.prompt, params);
      if (template.solution) fill(template.solution, params);
      for (const h of template.hints || []) fill(h, params);
    } catch (e) { return [e.message]; }
    try {
      if (a.type === 'number') {
        const v = evalIn(fill(a.expr, params), flat(params));
        if (!Number.isFinite(v)) return [`seed ${seed}: answer evaluates to ${v}`];
        const r = check(template, params, String(v));
        if (!r.ok) return [`seed ${seed}: reference answer fails its own check`];
      } else if (a.type === 'expression') {
        const self = fill(a.expr, params);
        const r = check(template, params, self);
        if (r.error) return [`seed ${seed}: ${r.error}`];
        if (!r.ok) return [`seed ${seed}: reference answer fails its own check`];
      } else if (a.type === 'choice') {
        if (!Array.isArray(a.options) || a.options.length < 2) return ['choice needs 2+ options'];
        if (!(a.correct >= 0 && a.correct < a.options.length)) return ['correct index out of range'];
        const filled = a.options.map(o => fill(o, params));
        if (new Set(filled).size !== filled.length) return [`seed ${seed}: duplicate options`];
      } else if (a.type !== 'self') {
        return [`unknown answer type "${a.type}"`];
      }
    } catch (e) { return [`seed ${seed}: ${e.message}`]; }
  }
  return problems;
}
