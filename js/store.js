// Persistence: one JSON blob in localStorage, plus export/import.
// Seed decks are merged in at load so new cards in a shipped deck
// appear without touching anyone's scheduling state.

import { newState } from './fsrs.js';

const KEY = 'studyflex-v1';

export function defaultState() {
  return {
    version: 1,
    settings: { newPerDay: 5, retention: 0.9, theme: 'auto' },
    templates: {},   // id -> {tpl, deckId, custom, suspended, srs}
    logs: [],        // {t, id, ok, ms, hints, grade, practice, n, params}
  };
}

export function load(decks, storage = globalThis.localStorage) {
  let state = defaultState();
  try {
    const raw = storage && storage.getItem(KEY);
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch { /* corrupted or unavailable storage: start fresh */ }
  for (const deck of decks) {
    for (const tpl of deck.templates) {
      const have = state.templates[tpl.id];
      if (!have) {
        state.templates[tpl.id] = {
          tpl, deckId: deck.id, custom: false, suspended: false, srs: newState(),
        };
      } else if (!have.custom) {
        have.tpl = tpl; // shipped fixes win unless the card was edited
        have.deckId = deck.id;
      }
    }
  }
  return state;
}

export function save(state, storage = globalThis.localStorage) {
  if (storage) storage.setItem(KEY, JSON.stringify(state));
}

export function exportJSON(state) {
  return JSON.stringify(state, null, 1);
}

export function importJSON(raw) {
  const data = JSON.parse(raw);
  if (!data || data.version !== 1 || !data.templates || !data.logs) {
    throw new Error('not a studyflex export');
  }
  return { ...defaultState(), ...data };
}

// Local calendar date, since "today" means the user's today.
export function dayOf(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Consecutive days with at least one graded review, ending today or
// yesterday (a streak is not broken until a whole day is missed).
export function streak(logs, now) {
  const days = new Set(logs.filter(l => !l.practice).map(l => dayOf(l.t)));
  let count = 0;
  let cursor = now;
  if (!days.has(dayOf(cursor))) cursor -= 86400000;
  while (days.has(dayOf(cursor))) { count++; cursor -= 86400000; }
  return count;
}
