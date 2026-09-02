// A miniature Supabase for the sync tests: GoTrue password auth and
// the two PostgREST routes sync.js uses, in memory, on a random
// port. Just enough fidelity to catch real merge bugs.

import { createServer } from 'node:http';

export function startMock() {
  const users = {};   // email -> {password, id}
  const tokens = {};  // access_token -> user id
  const logs = [];    // {seq, user_id, k, entry}
  const states = {};  // user_id -> {updated_at, data}
  let seq = 0, tokenN = 0;

  function session(id, email) {
    const access = `tok-${++tokenN}`;
    tokens[access] = id;
    return {
      access_token: access, refresh_token: `ref-${id}`, token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id, email },
    };
  }

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'apikey, authorization, content-type, prefer',
      };
      const send = (code, data) => {
        res.writeHead(code, { 'content-type': 'application/json', ...cors });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      if (req.method === 'OPTIONS') return send(204);
      const auth = () => tokens[(req.headers.authorization || '').replace('Bearer ', '')];
      const data = body ? JSON.parse(body) : null;

      if (url.pathname === '/auth/v1/signup') {
        if (users[data.email]) return send(400, { msg: 'User already registered' });
        const id = `user-${Object.keys(users).length + 1}`;
        users[data.email] = { password: data.password, id };
        return send(200, session(id, data.email));
      }
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
        const u = users[data.email];
        if (!u || u.password !== data.password) return send(400, { msg: 'Invalid login credentials' });
        return send(200, session(u.id, data.email));
      }
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
        const id = data.refresh_token.replace('ref-', '');
        return send(200, session(id, 'refreshed'));
      }

      const uid = auth();
      if (!uid) return send(401, { message: 'no token' });

      if (url.pathname === '/rest/v1/sf_logs' && req.method === 'GET') {
        const after = Number((url.searchParams.get('seq') || 'gt.0').replace('gt.', ''));
        return send(200, logs
          .filter(r => r.user_id === uid && r.seq > after)
          .map(r => ({ seq: r.seq, k: r.k, entry: r.entry })));
      }
      if (url.pathname === '/rest/v1/sf_logs' && req.method === 'POST') {
        for (const row of data) {
          if (logs.some(r => r.user_id === uid && r.k === row.k)) continue;
          logs.push({ seq: ++seq, user_id: uid, k: row.k, entry: row.entry });
        }
        return send(201);
      }
      if (url.pathname === '/rest/v1/sf_state' && req.method === 'GET') {
        return send(200, states[uid] ? [states[uid]] : []);
      }
      if (url.pathname === '/rest/v1/sf_state' && req.method === 'POST') {
        states[uid] = { updated_at: data[0].updated_at, data: data[0].data };
        return send(201);
      }
      send(404, { message: `no route ${req.method} ${url.pathname}` });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => server.close(),
        rows: () => logs,
      });
    });
  });
}
