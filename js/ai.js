// Optional: draft cards from pasted notes with Claude. Loaded only
// when the user actually clicks the button, so the rest of the app
// stays offline. Uses the official SDK (pinned) with the user's own
// API key, which never leaves this browser except to Anthropic.

const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@0.122.0?target=es2022';

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['cloze', 'term', 'explain'] },
          name: { type: 'string', description: 'short card title' },
          skills: { type: 'array', items: { type: 'string' }, description: '1-2 lowercase skill tags' },
          text: { type: 'string', description: 'cloze only: one or two sentences with 1-3 key spans wrapped in [[double brackets]]' },
          front: { type: 'string', description: 'term and explain: the question' },
          accept: { type: 'array', items: { type: 'string' }, description: 'term only: accepted short answers, most canonical first' },
          solution: { type: 'string', description: 'explain only: the model answer' },
        },
        required: ['kind', 'name', 'skills'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
};

const SYSTEM = `You turn a student's study notes into flashcards for a spaced repetition app. Card kinds:
- "cloze": one or two sentences copied or tightened from the notes, with 1 to 3 genuinely load-bearing words or short phrases wrapped in [[double brackets]]. The app hides one span per review and the student types it. Never bracket filler words.
- "term": a direct question with a short typed answer (a word, name, number, or phrase under ~40 characters). Put every reasonable accepted phrasing in "accept", canonical first.
- "explain": an open prompt asking the student to reproduce an argument, derivation, or explanation from memory, with a "solution" they will compare against. Use for anything too big to type.
Prefer cloze and term. Cover the important ideas in the notes without inventing facts that are not there. 5 to 20 cards depending on how much substance the notes contain. Wording stays close to the notes so the student recognizes their own material.`;

export async function draftCards(notes, apiKey) {
  const { default: Anthropic } = await import(SDK_URL);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const response = await client.beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: CARD_SCHEMA } },
    messages: [{ role: 'user', content: notes }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('the model declined to process these notes');
  }
  const text = response.content.find(b => b.type === 'text')?.text || '';
  const cards = JSON.parse(text).cards || [];
  return cards.map(toTemplate).filter(Boolean);
}

// Map a drafted card onto the app's template shape. Invalid drafts
// return null and are dropped; the caller validates the rest again
// before anything is saved.
function toTemplate(card) {
  const base = {
    id: `notes/${slug(card.name)}-${counter()}`,
    name: card.name,
    skills: (card.skills || []).slice(0, 3).map(s => String(s).toLowerCase()),
    params: {},
  };
  if (!base.name || !base.skills.length) return null;
  if (card.kind === 'cloze' && card.text && /\[\[.+?\]\]/.test(card.text)) {
    return { ...base, prompt: card.text, par: 30, answer: { type: 'cloze' } };
  }
  if (card.kind === 'term' && card.front && card.accept?.length) {
    return { ...base, prompt: card.front, par: 25, answer: { type: 'text', accept: card.accept } };
  }
  if (card.kind === 'explain' && card.front && card.solution) {
    return { ...base, prompt: card.front, par: 90, answer: { type: 'self' }, solution: card.solution };
  }
  return null;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'card';
}

let n = 0;
function counter() {
  n++;
  return `${Date.now().toString(36)}${n}`;
}
