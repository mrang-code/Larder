// Larder server — runs free on Cloudflare Workers.
//
// 1. Expiry reminders: once an hour it checks who is due a reminder today and sends their phone an
//    empty "ping". The Larder app on the phone then works out what needs using up and shows the
//    notification. For reminders it only stores a push address and a list of dates — no food names.
//    It can also send an end-of-day nudge to copy your food diary into Google Health.
// 2. Shared kitchen: keeps one copy of a household's kitchen, list, plan and cookbook, so several
//    phones stay in sync. Each household is protected by a secret in its invite code.
//
// 3. AI: the Gemini key lives here, not on the phones. Phones send their AI requests to /ai, and this
//    server adds the key, applies the daily limits and passes the answer straight back.
//    The admin code (set once with /admin/setup) is needed to change the key, model or limits.
//
// Setup (see the guide): paste this file into a Worker, add a KV binding named DB,
// and add a Cron Trigger of  0 * * * *  (every hour).

const ALLOWED_ORIGINS = ['https://mrang-code.github.io'];   // the site(s) allowed to use this server
const SUBJECT = 'https://mrang-code.github.io/Larder/';     // contact address sent to the push services
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];

const enc = s => new TextEncoder().encode(s);
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function cors(origin) {
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin'};
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {status: status || 200, headers: {'Content-Type': 'application/json', ...cors(origin)}});
}
function okEndpoint(endpoint) {
  try { const u = new URL(endpoint); return u.protocol === 'https:' && PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h)); }
  catch (e) { return false; }
}
// Combine two copies of a kitchen. Every record carries _u (when it last changed) and deletions are
// remembered in `del` for 60 days, so edits from different phones merge instead of overwriting.
function mergeStates(a, b){
  a = a || {}; b = b || {};
  const now = Date.now(), del = {};
  [a.del || {}, b.del || {}].forEach(d => { for (const k in d) if (!(del[k] >= d[k])) del[k] = d[k]; });
  for (const k in del) if (now - del[k] > 60 * 864e5) delete del[k];
  const out = {};
  const COL = {items:'i', spices:'s', list:'l', saved:'r', log:'g'};
  for (const c in COL){
    const p = COL[c], m = new Map(), order = [];
    const add = r => { if (!r || r.id == null) return; const ex = m.get(r.id);
      if (!ex){ m.set(r.id, r); order.push(r.id); } else if ((r._u || 0) > (ex._u || 0)) m.set(r.id, r); };
    (Array.isArray(a[c]) ? a[c] : []).forEach(add); (Array.isArray(b[c]) ? b[c] : []).forEach(add);
    out[c] = order.map(id => m.get(id)).filter(r => !(del[p + ':' + r.id] >= (r._u || 0)));
  }
  const pa = a.plan || {}, pb = b.plan || {}, ua = a.planU || {}, ub = b.planU || {};
  out.plan = {}; out.planU = {};
  new Set([...Object.keys(pa), ...Object.keys(pb), ...Object.keys(ua), ...Object.keys(ub)]).forEach(d => {
    const fromA = (ua[d] || 0) >= (ub[d] || 0), v = fromA ? (pa[d] || pb[d]) : (pb[d] || pa[d]), u = Math.max(ua[d] || 0, ub[d] || 0);
    if (u) out.planU[d] = u;
    if (Array.isArray(v) && v.length && !(del['p:' + d] >= u)) out.plan[d] = v;
  });
  out.prefs = (a.prefsU || 0) >= (b.prefsU || 0) ? (a.prefs || b.prefs) : (b.prefs || a.prefs);
  out.prefsU = Math.max(a.prefsU || 0, b.prefsU || 0);
  out.del = del;
  return out;
}

const okId = s => /^[a-z0-9]{10}$/.test(String(s || ''));
function rid(n) { const a = 'abcdefghijkmnpqrstuvwxyz23456789', b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map(x => a[x % a.length]).join(''); }
async function sha(s) { return b64u(await crypto.subtle.digest('SHA-256', enc(String(s)))); }
function cleanState(st) {
  st = st && typeof st === 'object' ? st : {};
  const o = {};
  ['items', 'spices', 'list', 'saved', 'log'].forEach(k => { o[k] = Array.isArray(st[k]) ? st[k] : []; });
  ['plan', 'planU', 'del'].forEach(k => { o[k] = st[k] && typeof st[k] === 'object' && !Array.isArray(st[k]) ? st[k] : {}; });
  o.prefs = st.prefs && typeof st.prefs === 'object' ? st.prefs : undefined; o.prefsU = +st.prefsU || 0;
  return o;
}
async function household(path, b, env, origin) {
  if (path === '/hh/new') {
    const id = rid(10), secret = rid(24), state = cleanState(b.state);
    await env.DB.put('hh:' + id, JSON.stringify({h: await sha(secret), state, t: Date.now()}));
    return json({id, secret, state}, 200, origin);
  }
  if (path === '/hh/sync') {
    if (!okId(b.id)) return json({error: 'Bad kitchen id'}, 400, origin);
    const rec = await env.DB.get('hh:' + b.id, 'json');
    if (!rec) return json({error: 'No such kitchen'}, 404, origin);
    if (rec.h !== await sha(b.secret || '')) return json({error: 'Wrong code'}, 403, origin);
    if (b.state && typeof b.state === 'object') {
      rec.state = mergeStates(cleanState(b.state), rec.state); rec.t = Date.now();
      try { await env.DB.put('hh:' + b.id, JSON.stringify(rec)); } catch (e) { return json({error: 'Busy, try again'}, 503, origin); }
    }
    return json({state: rec.state}, 200, origin);
  }
  return json({error: 'Not found'}, 404, origin);
}

// ---------- shared settings, admin and AI ----------
const DEFAULTS = {key: '', model: 'gemini-3.5-flash', best: false, limits: {photo: 5, gen: 10, total: 150}};
async function getCfg(env) { const c = await env.DB.get('cfg', 'json'); return {...DEFAULTS, ...(c || {}), limits: {...DEFAULTS.limits, ...((c || {}).limits || {})}}; }
const publicCfg = c => ({ai: !!c.key, model: c.model, best: !!c.best, limits: c.limits});
const okModel = m => /^gemini-[a-z0-9.\-]{1,40}$/.test(String(m || ''));
const today = () => new Date().toISOString().slice(0, 10);
async function adminOk(env, code, ip) {
  const a = await env.DB.get('admin', 'json'); if (!a) return 'nosetup';
  const lk = 'lock:' + (ip || 'x'), lock = await env.DB.get(lk, 'json');
  if (lock && lock.n >= 5 && Date.now() - lock.t < 3600e3) return 'locked';
  if (a.h === await sha(a.salt + String(code || ''))) return 'ok';
  await env.DB.put(lk, JSON.stringify({n: (lock && Date.now() - lock.t < 3600e3 ? lock.n : 0) + 1, t: Date.now()}), {expirationTtl: 3600});
  return 'bad';
}
async function admin(path, b, env, origin, ip) {
  if (path === '/admin/setup') {
    if (await env.DB.get('admin')) return json({error: 'Admin code is already set'}, 403, origin);
    const code = String(b.code || ''); if (code.length < 6) return json({error: 'Use at least 6 characters'}, 400, origin);
    const salt = rid(16); await env.DB.put('admin', JSON.stringify({salt, h: await sha(salt + code)}));
    return json({ok: true}, 200, origin);
  }
  const v = await adminOk(env, b.code, ip);
  if (v !== 'ok') return json({error: v === 'nosetup' ? 'Admin code not set up yet' : v === 'locked' ? 'Too many wrong codes. Try again in an hour.' : 'Wrong admin code'}, v === 'nosetup' ? 404 : 403, origin);
  const c = await getCfg(env);
  if (path === '/admin/config' && b.set && typeof b.set === 'object') {
    const s = b.set;
    if (typeof s.key === 'string' && s.key.trim()) c.key = s.key.trim().slice(0, 200);
    if (s.clearKey) c.key = '';
    if (okModel(s.model)) c.model = s.model;
    if (typeof s.best === 'boolean') c.best = s.best;
    if (s.limits && typeof s.limits === 'object') ['photo', 'gen', 'total'].forEach(k => { const n = Math.round(+s.limits[k]); if (n >= 0 && n <= 10000) c.limits[k] = n; });
    if (typeof s.newCode === 'string' && s.newCode.length >= 6) { const salt = rid(16); await env.DB.put('admin', JSON.stringify({salt, h: await sha(salt + s.newCode)})); }
    await env.DB.put('cfg', JSON.stringify(c));
  }
  const use = (await env.DB.get('use:all:' + today(), 'json')) || {n: 0};
  return json({ok: true, cfg: {...publicCfg(c), keyEnd: c.key ? c.key.slice(-4) : ''}, today: use.n}, 200, origin);
}
// Counts one AI action per phone (an action can take more than one request when a model falls back).
const WEEK = 7 * 864e5;
async function spendAI(env, c, dev, kind, aid) {
  const d = today(), lim = c.limits;
  if (kind === 'price') {                      // live prices: once a week per phone (up to 3 tries of the same check)
    const wk = 'use:' + dev + ':price', w = await env.DB.get(wk, 'json');
    if (w && Date.now() - w.t < WEEK) {
      if (w.aid !== aid || w.n >= 3) return 'price';
      w.n++; await env.DB.put(wk, JSON.stringify(w), {expirationTtl: 8 * 86400}); return null;
    }
    const all = (await env.DB.get('use:all:' + d, 'json')) || {n: 0};
    if (all.n >= lim.total) return 'total';
    all.n++;
    await env.DB.put(wk, JSON.stringify({aid, t: Date.now(), n: 1}), {expirationTtl: 8 * 86400});
    await env.DB.put('use:all:' + d, JSON.stringify(all), {expirationTtl: 3 * 86400});
    return null;
  }
  const uk = 'use:' + dev + ':' + d, u = (await env.DB.get(uk, 'json')) || {photo: [], gen: [], other: []};
  const list = u[kind] || (u[kind] = []);
  if (list.includes(aid)) return null;
  const all = (await env.DB.get('use:all:' + d, 'json')) || {n: 0};
  if (all.n >= lim.total) return 'total';
  if (kind === 'photo' && list.length >= lim.photo) return 'photo';
  if (kind === 'gen' && list.length >= lim.gen) return 'gen';
  if (kind === 'other' && list.length >= 30) return 'other';
  list.push(aid); all.n++;
  await env.DB.put(uk, JSON.stringify(u), {expirationTtl: 3 * 86400});
  await env.DB.put('use:all:' + d, JSON.stringify(all), {expirationTtl: 3 * 86400});
  return null;
}
async function ai(b, env, origin) {
  const c = await getCfg(env);
  if (!c.key) return json({error: {code: 503, message: 'AI is not set up yet. Ask the admin to add a Gemini key.'}}, 503, origin);
  const dev = String(b.dev || ''), aid = String(b.aid || ''), kind = ['photo', 'gen', 'other', 'price'].includes(b.kind) ? b.kind : 'other';
  if (!/^[a-z0-9]{8,24}$/.test(dev) || !/^[a-z0-9]{6,24}$/.test(aid)) return json({error: {code: 400, message: 'Bad request'}}, 400, origin);
  const over = await spendAI(env, c, dev, kind, aid);
  if (over) return json({error: {code: 429, message: 'limit:' + over}}, 429, origin);
  const model = okModel(b.model) ? b.model : c.model;
  const up = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': c.key}, body: JSON.stringify(b.body || {})});
  if (!up.ok && kind === 'price') {             // a failed lookup doesn't use up the week
    const wk = 'use:' + dev + ':price', w = await env.DB.get(wk, 'json');
    if (w && w.aid === aid && w.n <= 1) await env.DB.delete(wk);
  }
  return new Response(up.body, {status: up.status, headers: {'Content-Type': up.headers.get('Content-Type') || 'text/event-stream', 'Cache-Control': 'no-store', ...cors(origin)}});
}

async function keyFor(endpoint) { return 'sub:' + b64u(await crypto.subtle.digest('SHA-256', enc(endpoint))); }

// The server makes its own signing keys the first time it runs and keeps them in storage.
async function vapid(env) {
  let v = await env.DB.get('vapid', 'json');
  if (!v) {
    const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
    v = {jwk: await crypto.subtle.exportKey('jwk', pair.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', pair.publicKey))};
    await env.DB.put('vapid', JSON.stringify(v));
  }
  return v;
}

// Send one empty push message. Returns the push service's HTTP status.
async function ping(env, endpoint) {
  const v = await vapid(env);
  const key = await crypto.subtle.importKey('jwk', v.jwk, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign']);
  const head = b64u(enc(JSON.stringify({typ: 'JWT', alg: 'ES256'})));
  const body = b64u(enc(JSON.stringify({aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT})));
  const sig = b64u(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, enc(head + '.' + body)));
  const res = await fetch(endpoint, {method: 'POST', body: new Uint8Array(0), headers: {'TTL': '43200', 'Urgency': 'normal', 'Authorization': `vapid t=${head}.${body}.${sig}, k=${v.pub}`}});
  return res.status;
}

function localNow(tz) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-GB', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'}); }
  catch (e) { fmt = new Intl.DateTimeFormat('en-GB', {timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'}); }
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return {date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24};
}

async function runDue(env) {
  let cursor, sent = 0;
  do {
    const page = await env.DB.list({prefix: 'sub:', cursor});
    for (const {name} of page.keys) {
      const s = await env.DB.get(name, 'json');
      if (!s || !s.endpoint) continue;
      const now = localNow(s.tz);
      const expDue = now.hour >= s.hour && s.last !== now.date && (s.dates || []).includes(now.date);
      const diaryDue = s.diary >= 0 && now.hour >= s.diary && s.lastD !== now.date;
      if (!expDue && !diaryDue) continue;
      let status = 0;
      try { status = await ping(env, s.endpoint); } catch (e) {}
      if (status === 404 || status === 410) { await env.DB.delete(name); continue; }   // phone unsubscribed
      if (status >= 200 && status < 300) { if (expDue) s.last = now.date; if (diaryDue) s.lastD = now.date; await env.DB.put(name, JSON.stringify(s)); sent++; }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return sent;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors(origin)});
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response('Larder server is running (v5).\nStorage: ' + (env.DB ? 'connected' : 'NOT connected - add a KV binding named DB'), {headers: {'Content-Type': 'text/plain', ...cors(origin)}});
    }
    if (!env.DB) return json({error: 'Storage is not connected. Add a KV binding named DB.'}, 500, origin);
    if (req.method === 'GET' && url.pathname === '/key') return json({key: (await vapid(env)).pub}, 200, origin);
    if (req.method === 'GET' && url.pathname === '/config') return json(publicCfg(await getCfg(env)), 200, origin);
    if (req.method !== 'POST') return json({error: 'Not found'}, 404, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({error: 'Not allowed'}, 403, origin);

    if (+(req.headers.get('Content-Length') || 0) > 8e6) return json({error: 'Too large'}, 413, origin);
    let b; try { b = await req.json(); } catch (e) { return json({error: 'Bad request'}, 400, origin); }
    if (url.pathname.startsWith('/hh/')) return household(url.pathname, b || {}, env, origin);
    if (url.pathname === '/ai') return ai(b || {}, env, origin);
    if (url.pathname.startsWith('/admin/')) return admin(url.pathname, b || {}, env, origin, req.headers.get('CF-Connecting-IP') || '');
    const endpoint = String((b && b.sub && b.sub.endpoint) || (b && b.endpoint) || '');
    if (!okEndpoint(endpoint)) return json({error: 'Bad subscription'}, 400, origin);
    const k = await keyFor(endpoint);

    if (url.pathname === '/subscribe') {
      const dates = (Array.isArray(b.dates) ? b.dates : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 150);
      const h = Number(b.hour); const hour = Number.isFinite(h) ? Math.min(23, Math.max(0, Math.round(h))) : 17;
      const old = await env.DB.get(k, 'json');
      const dh = Number(b.diary); const diary = Number.isFinite(dh) && dh >= 0 ? Math.min(23, Math.round(dh)) : -1;
      await env.DB.put(k, JSON.stringify({endpoint, dates, hour, diary, tz: String(b.tz || 'Europe/London').slice(0, 64), last: old ? old.last || '' : '', lastD: old ? old.lastD || '' : ''}));
      return json({ok: true, days: dates.length}, 200, origin);
    }
    if (url.pathname === '/unsubscribe') { await env.DB.delete(k); return json({ok: true}, 200, origin); }
    if (url.pathname === '/test') {
      if (!(await env.DB.get(k))) return json({error: 'Not subscribed'}, 404, origin);
      let status = 0; try { status = await ping(env, endpoint); } catch (e) {}
      return json({ok: status >= 200 && status < 300, status}, 200, origin);
    }
    return json({error: 'Not found'}, 404, origin);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runDue(env)); }
};
