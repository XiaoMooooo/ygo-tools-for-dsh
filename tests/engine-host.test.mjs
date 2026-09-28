// The real engine host: token authentication, session lifecycle, and the
// contract codes as observed over HTTP.
//
// The host is spawned with stdio 'ignore' on purpose: this suite must also run
// where the harness forbids capturing a child's piped stdio.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { reporter, ROOT } from './harness.mjs';

const t = reporter();
const SERVER = `${ROOT}/skill/backend/persistent-engine-server.mjs`;
const PORT = Number(process.env.YGO_TEST_PORT ?? 19979);
const TOKEN = 'test-token-abcdef0123456789';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = join(ROOT, 'tests', '.sandbox', 'engine-host');

rmSync(DATA, { recursive: true, force: true });

t.section('token authentication over HTTP');
const child = spawn(process.execPath, [SERVER, '--host', '127.0.0.1', '--port', String(PORT)], {
  env: { ...process.env, YGO_ENGINE_TOKEN: TOKEN },
  stdio: 'ignore',
  windowsHide: true,
});

try {
  let healthy = false;
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) { healthy = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!healthy) {
    t.assert('the engine host starts and answers /health', false, `no response on ${BASE}`);
    child.kill();
    t.finish();
  }
  t.assert('the engine host starts and answers /health', true);

  t.check('/health is reachable without a token', (await fetch(`${BASE}/health`)).status, 200);
  t.check('/tools without a token is refused', (await fetch(`${BASE}/tools`)).status, 401);
  t.check('/tools with a wrong token is refused',
    (await fetch(`${BASE}/tools`, { headers: { 'x-ygo-engine-token': 'wrong-token-wrong-token-wrong' } })).status, 401);
  t.check('/tools with the right token is accepted',
    (await fetch(`${BASE}/tools`, { headers: { 'x-ygo-engine-token': TOKEN } })).status, 200);
  const unauthenticatedExecute = await fetch(`${BASE}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call: { name: 'manageEngineSession', input: { action: 'shutdown', confirm: true } } }),
  });
  t.check('/execute without a token is refused', unauthenticatedExecute.status, 401);
  t.assert('an unauthenticated caller cannot shut the host down', unauthenticatedExecute.status === 401);
} finally {
  child.kill();
}

t.section('session lifecycle');
const { createModelToolHost } = await import(`file:///${ROOT}/skill/backend/model-tool-host.mjs`);
const host = createModelToolHost({}, { idleTimeoutMs: 40 });
host.createSession('dsh-agent-1');
host.createSession('dsh-agent-2');
t.check('sessions are registered', host.listSessions().length, 2);
await new Promise((r) => setTimeout(r, 60));
t.check('idle sessions are reaped', host.reapIdleSessions().length, 2);
t.check('the session map is emptied', host.listSessions().length, 0);
host.createSession('dsh-agent-3');
t.check('a fresh session is not reaped', host.reapIdleSessions().length, 0);
t.check('the fresh session survives', host.listSessions().length, 1);
host.clearSessions();
t.check('clearSessions empties the map', host.listSessions().length, 0);

t.section('contract codes over HTTP (client + spawned host)');
const { createPersistentEngineClient } = await import(`file:///${ROOT}/skill/backend/persistent-engine-client.mjs`);
const client = createPersistentEngineClient({
  hostname: '127.0.0.1',
  port: PORT,
  autoStart: true,
  serverEnv: { YGO_CACHE_DIR: join(DATA, 'cache') },
});
const session = { sessionId: 'dsh-test' };
const call = async (name, input) => {
  const raw = await client.execute({ name, input }, session);
  return raw?.result ?? raw;
};

t.check('the client discovers the 15 public tools', (await client.listTools()).length, 15);
t.check('the client resolves an auth token', client.hasToken, true);

const noIdentifier = await call('queryCards', { action: 'get' });
t.check('get without an identifier is refused', noIdentifier.ok, false);
t.check('  at the invalid-input layer', noIdentifier.code, 'INVALID_TOOL_INPUT');
t.check('  with MISSING_REQUIRED_ARGUMENT', noIdentifier.data?.errors?.[0]?.code, 'MISSING_REQUIRED_ARGUMENT');
const bogus = await call('queryCards', { action: 'lookup' });
t.check('an unknown action is refused', bogus.ok, false);
t.check('  with INVALID_ACTION', bogus.data?.errors?.[0]?.code, 'INVALID_ACTION');

t.section('a genuine call still works against the bundled card data');
// The bundled cards.cdb is the OCG database, so query in its own language.
const card = '青眼白龙';
const search = await call('queryCards', { action: 'search', query: card, limit: 3 });
t.check('search succeeds', search.ok, true);
const results = search.data?.results ?? [];
t.assert('search returns results', Array.isArray(results) && results.length > 0, JSON.stringify(search).slice(0, 300));
t.note(`hits: ${results.slice(0, 3).map((c) => c?.name).join(' | ')}`);
t.check('get by name succeeds', (await call('queryCards', { action: 'get', cardName: card })).ok, true);
t.check('engine status still works', (await call('manageEngineSession', { action: 'status' })).ok, true);

await call('manageEngineSession', { action: 'shutdown', confirm: true });
await new Promise((r) => setTimeout(r, 800));
rmSync(DATA, { recursive: true, force: true });

t.finish();
