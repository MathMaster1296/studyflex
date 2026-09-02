// Optional sync against the user's own Supabase project, hand-rolled
// over its REST API (GoTrue for auth, PostgREST for tables) so the
// app stays dependency-free. Reviews travel as append-only log rows
// and memory state is rebuilt from the merged log, so two devices
// cannot fight over a card; the small cards-and-settings document is
// last-write-wins. Nothing here runs unless the user configures it.

const CHUNK = 500;

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// The subset of state that syncs as one document.
export function stateDoc(state) {
  const custom = {};
  const suspended = [];
  for (const [id, e] of Object.entries(state.templates)) {
    if (e.custom) custom[id] = { tpl: e.tpl, deckId: e.deckId };
    if (e.suspended) suspended.push(id);
  }
  const { apiKey, ...settings } = state.settings; // the API key never leaves this browser
  return { custom, suspended: suspended.sort(), settings, gamify: state.gamify };
}

export function docHash(state) {
  return hash(JSON.stringify(stateDoc(state)));
}

// Merge a document from another device into local state. On a
// device's first sync nothing local is deleted, so signing in from a
// machine with its own cards keeps both sides; after that, a card
// missing from the document was deleted elsewhere and goes.
export function applyStateDoc(state, doc, newSrs, first = false) {
  state.settings = { ...doc.settings, apiKey: state.settings.apiKey };
  for (const [id, entry] of Object.entries(doc.custom)) {
    const have = state.templates[id];
    state.templates[id] = {
      tpl: entry.tpl, deckId: entry.deckId, custom: true,
      suspended: false, srs: have ? have.srs : newSrs(),
    };
  }
  for (const [id, e] of Object.entries(state.templates)) {
    if (!first && e.custom && !doc.custom[id]) { delete state.templates[id]; continue; }
    e.suspended = doc.suspended.includes(id) || (first && e.suspended);
  }
  const g = state.gamify, other = doc.gamify;
  g.frozenDays = [...new Set([...g.frozenDays, ...other.frozenDays])];
  g.seenBadges = [...new Set([...g.seenBadges, ...other.seenBadges])];
  g.freezes = Math.max(g.freezes, other.freezes);
  g.earnedFreezes = Math.max(g.earnedFreezes, other.earnedFreezes);
}

// A deleted or undone review syncs as a tombstone row ({tomb: k})
// rather than a server-side delete, so devices that already pulled
// the entry remove it too and everyone converges on the same log.
export function applyTombs(state) {
  const targets = new Set(state.logs.filter(l => l.tomb).map(l => l.tomb));
  if (!targets.size) return;
  state.logs = state.logs.filter(l => !targets.has(l.k));
}

export function createSync({ url, anonKey, meta }) {
  const base = url.replace(/\/$/, '');
  let m = { session: null, lastSeq: 0, lastStateAt: 0, lastStateHash: '', ...meta.load() };
  const saveMeta = () => meta.save(m);

  async function call(path, options = {}, auth = true) {
    const headers = {
      apikey: anonKey,
      'content-type': 'application/json',
      ...(auth && m.session ? { authorization: `Bearer ${m.session.access_token}` } : {}),
      ...options.headers,
    };
    const res = await fetch(base + path, { ...options, headers });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const b = await res.json(); msg = b.msg || b.message || b.error_description || b.error || msg; } catch { /* keep the status */ }
      throw new Error(msg);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function ensureToken() {
    if (!m.session) throw new Error('not signed in');
    if (Date.now() < (m.session.expires_at - 60) * 1000) return;
    const s = await call('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: m.session.refresh_token }),
    }, false);
    m.session = s;
    saveMeta();
  }

  return {
    user: () => m.session?.user?.email || null,

    // Returns null when the account needs email confirmation first.
    async signUp(email, password) {
      const s = await call('/auth/v1/signup', {
        method: 'POST', body: JSON.stringify({ email, password }),
      }, false);
      if (s && s.access_token) { m.session = s; saveMeta(); return this.user(); }
      return null;
    },

    async signIn(email, password) {
      m.session = await call('/auth/v1/token?grant_type=password', {
        method: 'POST', body: JSON.stringify({ email, password }),
      }, false);
      saveMeta();
      return this.user();
    },

    signOut() {
      m = { session: null, lastSeq: 0, lastStateAt: 0, lastStateHash: '' };
      saveMeta();
    },

    // Pull, merge, push. applyDoc(docData, first) is called when a
    // server document should be folded into local state. Returns
    // counts so the UI can say something.
    async sync(state, applyDoc) {
      await ensureToken();

      const rows = await call(`/rest/v1/sf_logs?select=seq,k,entry&seq=gt.${m.lastSeq}&order=seq.asc`);
      const known = new Set(state.logs.map(l => l.k));
      let pulled = 0;
      for (const row of rows) {
        m.lastSeq = Math.max(m.lastSeq, row.seq);
        if (known.has(row.k)) continue;
        state.logs.push({ ...row.entry, k: row.k, synced: 1 });
        pulled++;
      }
      applyTombs(state);
      if (pulled) state.logs.sort((a, b) => a.t - b.t);

      const unsent = state.logs.filter(l => !l.synced);
      for (let i = 0; i < unsent.length; i += CHUNK) {
        const batch = unsent.slice(i, i + CHUNK).map(l => {
          const { synced, ...entry } = l;
          return { k: l.k, t: l.t, card: l.id || null, entry };
        });
        await call('/rest/v1/sf_logs?on_conflict=user_id,k', {
          method: 'POST',
          headers: { prefer: 'resolution=ignore-duplicates' },
          body: JSON.stringify(batch),
        });
      }
      for (const l of unsent) l.synced = 1;

      // The cards-and-settings document. A device's first sync merges
      // the server copy in; after that a newer server copy is adopted
      // when local is unchanged, and otherwise the local edit wins.
      const first = !m.lastStateHash && !m.lastStateAt;
      const localUnchanged = docHash(state) === m.lastStateHash;
      const remote = (await call('/rest/v1/sf_state?select=updated_at,data'))[0] || null;
      const remoteChanged = remote && remote.updated_at > m.lastStateAt;
      let docNote = '';
      if (remote && (first || (remoteChanged && localUnchanged))) {
        applyDoc(remote.data, first);
        m.lastStateAt = remote.updated_at;
        docNote = first ? 'merged' : 'adopted';
      } else if (remoteChanged) {
        docNote = 'conflict, this device won';
      }
      const localHash = docHash(state);
      if (!remote || localHash !== hash(JSON.stringify(remote.data))) {
        // strictly newer than the server copy, so a fast sequence of
        // syncs (or a device with a slow clock) cannot write a
        // winning version that looks stale to everyone else
        const updated_at = Math.max(Date.now(), (remote?.updated_at || 0) + 1);
        await call('/rest/v1/sf_state?on_conflict=user_id', {
          method: 'POST',
          headers: { prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify([{ updated_at, data: stateDoc(state) }]),
        });
        m.lastStateAt = updated_at;
      }
      m.lastStateHash = localHash;
      saveMeta();
      return { pulled, pushed: unsent.length, docNote };
    },
  };
}
