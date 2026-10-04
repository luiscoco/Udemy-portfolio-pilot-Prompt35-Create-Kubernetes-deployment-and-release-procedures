// Post-release smoke test for the single public origin (milestone 35). Read-only unless --mutate.
//   node scripts/k8s-smoke.mjs --origin https://<host> [--http-origin http://<host>] [--hold-seconds 330]
//        [--cookie-file <file with the Cookie header of a signed-in browser session>] [--mutate]
// Anonymous checks: TLS, SPA fallback and cache policy, security headers on both routes, readiness
// through the gateway, HTTP -> HTTPS redirect, and that /api/events requires a session.
// With a session (cookie file, or --demo-account on the local demo profile): the event stream is
// served as text/event-stream, heartbeats arrive one by one while the stream is idle (nothing buffers
// them), and the stream stays open for --hold-seconds (default 330: beyond the 120 s /api route
// timeout and Envoy's 5-minute stream idle timeout). --mutate also records a trade and expects its
// portfolio.updated event on the open stream (never use it against real user data).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);

export function client(origin) {
  async function call(cookie, path, { method = 'GET', body, headers = {}, redirect = 'manual' } = {}) {
    const response = await fetch(origin + path, { method, redirect, headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text, headers: response.headers };
  }
  async function demoSignIn(account) {
    const response = await fetch(`${origin}/api/auth/demo-sign-in`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ account }) });
    assert.equal(response.status, 200, `demo sign-in ${account}`);
    return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  }
  /**
   * EventSource semantics over fetch: frames, heartbeat comments and `id:` cursors are recorded with their
   * arrival time; with `reconnect`, an ended stream is reopened with Last-Event-ID (what a browser does).
   */
  function openStream(cookie, { reconnect = false } = {}) {
    const stream = { events: [], arrivals: [], heartbeats: [], connections: [], lastEventId: null, controller: new AbortController() };
    const connect = async () => {
      if (!stream.lastEventId) {
        const recovery = await call(cookie, '/api/events/recovery');
        assert.equal(recovery.status, 200, 'recovery cursor');
        stream.lastEventId = recovery.json.cursor;
      }
      const response = await fetch(`${origin}/api/events`, { headers: { cookie, 'last-event-id': stream.lastEventId, accept: 'text/event-stream' }, signal: stream.controller.signal });
      const connection = { status: response.status, contentType: response.headers.get('content-type'), openedAt: Date.now(), endedAt: null };
      stream.connections.push(connection);
      assert.equal(response.status, 200, 'event stream status');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { connection.endedAt = Date.now(); return; }
        buffer += decoder.decode(value, { stream: true });
        for (let index; (index = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(index + 2)) {
          let type = null, data = null;
          for (const line of buffer.slice(0, index).split('\n')) {
            if (line.startsWith(': heartbeat')) stream.heartbeats.push(Date.now());
            else if (line.startsWith('id:')) stream.lastEventId = line.slice(3).trim();
            else if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          if (type && data) { stream.events.push({ type, ...JSON.parse(data) }); stream.arrivals.push(Date.now()); }
        }
      }
    };
    stream.done = (async () => {
      do {
        try { await connect(); } catch (error) { if (error.name === 'AbortError') return; stream.error = error; if (!reconnect) return; }
        if (!reconnect || stream.controller.signal.aborted) return;
        await sleep(500);
      } while (!stream.controller.signal.aborted);
    })();
    stream.close = async () => { stream.controller.abort(); await stream.done; };
    return stream;
  }
  return { call, demoSignIn, openStream };
}

export async function waitFor(label, probe, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { try { const value = await probe(); if (value) return value; } catch { /* retry */ } }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function recordTrade(api, cookie) {
  const portfolio = (await api.call(cookie, '/api/portfolios')).json.portfolios[0].id;
  const trade = await api.call(cookie, `/api/portfolios/${portfolio}/transactions`, { method: 'POST', headers: { 'Idempotency-Key': `m35-smoke-${randomUUID()}` },
    body: { security: { symbol: 'ACME', exchangeMic: 'XNAS', currency: 'USD' }, side: 'BUY', quantity: '1', price: '10.00', fees: '0.10', occurredAt: '2025-01-10T15:00:00.000Z' } });
  assert.equal(trade.status, 200, `trade: ${trade.text}`);
  return portfolio;
}

/** Runs the checks; each result is { name, ok, detail | error }. Throws only on programming errors. */
export async function smoke({ origin, httpOrigin, cookie, demoAccount, mutate = false, holdSeconds = 330, onCheck = () => {} }) {
  const api = client(origin);
  const results = [];
  const check = async (name, body) => {
    try { const detail = await body(); results.push({ name, ok: true, ...(detail ? { detail } : {}) }); log(`PASS ${name}`); }
    catch (error) { results.push({ name, ok: false, error: error.message }); log(`FAIL ${name}: ${error.message}`); }
    onCheck(results.at(-1));
  };

  await check('static frontend: SPA fallback, cache policy, CSP and HSTS', async () => {
    const home = await api.call(null, '/');
    assert.equal(home.status, 200); assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.match(home.headers.get('strict-transport-security') ?? '', /max-age=\d+/);
    assert.equal(home.headers.get('cache-control'), 'no-cache');
    const deep = await api.call(null, '/portfolios/does-not-matter?tab=x');
    assert.equal(deep.status, 200); assert.equal(deep.text, home.text, 'deep link serves index.html');
    const asset = home.text.match(/\/assets\/[^"]+\.js/)[0];
    const script = await api.call(null, asset);
    assert.equal(script.status, 200); assert.match(script.headers.get('cache-control'), /immutable/);
    const missing = await api.call(null, '/assets/missing-0000.js');
    assert.equal(missing.status, 404); assert.equal(missing.headers.get('cache-control'), null, 'a 404 is never cached as immutable');
    return { asset };
  });
  await check('/api routes to the API with security headers; readiness through the gateway', async () => {
    const ready = await api.call(null, '/api/health/ready');
    assert.equal(ready.status, 200, ready.text); assert.equal(ready.json.status, 'ready', `readiness ${ready.text}`);
    for (const header of ['x-content-type-options', 'referrer-policy', 'strict-transport-security', 'x-frame-options']) assert.ok(ready.headers.get(header), `${header} on /api`);
    assert.ok(ready.headers.get('x-request-id'), 'the API itself answered');
    return ready.json.dependencies;
  });
  await check('/api/events requires a session (answered at once, not held open)', async () => {
    const started = Date.now();
    const response = await api.call(null, '/api/events', { headers: { accept: 'text/event-stream' } });
    assert.equal(response.status, 401); assert.ok(Date.now() - started < 5000);
  });
  if (httpOrigin) await check('HTTP redirects permanently to HTTPS', async () => {
    const response = await fetch(`${httpOrigin}/portfolios?x=1`, { redirect: 'manual' });
    assert.equal(response.status, 301);
    const location = new URL(response.headers.get('location'));
    assert.equal(location.protocol, 'https:'); assert.equal(location.pathname + location.search, '/portfolios?x=1');
    assert.equal(location.hostname, new URL(httpOrigin).hostname);
    // Envoy keeps a non-default port from the Host header (only a local port-forward sends one).
    if (!new URL(httpOrigin).port) assert.equal(location.port, '', 'redirect must go to the default HTTPS port');
    return { location: location.href };
  });

  let session = cookie ?? null;
  if (!session && demoAccount) await check(`demo sign-in (${demoAccount}) through the gateway`, async () => { session = await api.demoSignIn(demoAccount); });
  if (!session) { results.push({ name: 'authenticated event stream', ok: null, detail: 'skipped: no --cookie-file or demo account' }); return { results }; }
  const stream = api.openStream(session);
  await check('event stream: text/event-stream through the gateway', async () => {
    await waitFor('stream connected', () => stream.connections[0] || stream.error, 15000);
    if (stream.error) throw stream.error;
    assert.match(stream.connections[0].contentType, /text\/event-stream/);
  });
  if (mutate) await check('trade -> outbox -> Redis -> SSE on the open stream', async () => {
    const portfolio = await recordTrade(api, session);
    await waitFor('portfolio.updated', () => stream.events.find(e => e.type === 'portfolio.updated' && e.portfolioId === portfolio), 30000);
    return { portfolio };
  });
  await check(`idle stream held ${holdSeconds} s: heartbeats arrive one by one, the stream is not cut`, async () => {
    const until = stream.connections[0].openedAt + holdSeconds * 1000;
    while (Date.now() < until && !stream.connections[0].endedAt && !stream.error) await sleep(1000);
    if (stream.error) throw stream.error;
    assert.equal(stream.connections[0].endedAt, null, `stream ended after ${Math.round((stream.connections[0].endedAt - stream.connections[0].openedAt) / 1000)} s`);
    const gaps = stream.heartbeats.slice(1).map((t, i) => t - stream.heartbeats[i]);
    const expected = Math.floor(holdSeconds / 15) - 2;
    assert.ok(stream.heartbeats.length >= expected, `only ${stream.heartbeats.length} heartbeats (expected >= ${expected})`);
    // Buffering would deliver heartbeats in bursts (gaps near 0) instead of ~15 s apart.
    assert.ok(gaps.every(gap => gap > 10_000), `heartbeat gaps (ms): ${gaps.join(',')}`);
    return { heartbeats: stream.heartbeats.length, minGapMs: Math.min(...gaps), maxGapMs: Math.max(...gaps), heldSeconds: Math.round((Date.now() - stream.connections[0].openedAt) / 1000) };
  });
  await stream.close();
  return { results, session };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const origin = value('--origin');
  if (!origin?.startsWith('https://')) { console.error('Usage: node scripts/k8s-smoke.mjs --origin https://<host> [--http-origin http://<host>] [--cookie-file f] [--hold-seconds n] [--mutate]'); process.exit(2); }
  const cookieFile = value('--cookie-file');
  const { results } = await smoke({ origin, httpOrigin: value('--http-origin'), demoAccount: value('--demo-account'), mutate: args.includes('--mutate'),
    cookie: cookieFile ? readFileSync(cookieFile, 'utf8').trim() : undefined, holdSeconds: Number(value('--hold-seconds') ?? 330) });
  const failed = results.filter(r => r.ok === false).length;
  console.log(JSON.stringify({ origin, passed: results.filter(r => r.ok).length, failed, skipped: results.filter(r => r.ok === null).length, results }, null, 2));
  process.exitCode = failed ? 1 : 0;
}
