// The real engine host: token authentication, session lifecycle, and the
// contract codes as observed over HTTP.
//
// The host is spawned with stdio 'ignore' on purpose: this suite must also run
// where the harness forbids capturing a child's piped stdio.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
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
const { createPersistentEngineClient, DEFAULT_STARTUP_TIMEOUT_MS } =
  await import(`file:///${ROOT}/skill/backend/persistent-engine-client.mjs`);
const client = createPersistentEngineClient({
  hostname: '127.0.0.1',
  port: PORT,
  autoStart: true,
  serverEnv: { YGO_CACHE_DIR: join(DATA, 'cache') },
});
// A cold start on a slow machine is the difference between a slow first tool call
// and a failed one, so the default budget is asserted instead of left implicit: it
// must stay at 30 s (the plugin's own default) and never drift back to a value
// that assumes a warm developer machine.
t.check('the client default cold-start budget is 30 s', DEFAULT_STARTUP_TIMEOUT_MS, 30000);
const session = { sessionId: 'dsh-test' };
const call = async (name, input) => {
  const raw = await client.execute({ name, input }, session);
  return raw?.result ?? raw;
};

t.check('the client discovers the 16 public tools', (await client.listTools()).length, 16);
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

t.section('engine host diagnostics');
const status = await call('manageEngineSession', { action: 'status' });
t.check('status reports the host as reachable', status.data?.reachable, true);
t.check('status reports the configured port', status.data?.port, PORT);
t.check('status reports the host is not stale', status.data?.needsRestart, false);
t.check('status reports no error while healthy', status.data?.lastError, null);
t.check('status reports the token path the client used', status.data?.tokenPath, client.tokenPath);
t.assert('the client resolved a real token path',
  typeof client.tokenPath === 'string' && client.tokenPath.length > 0, String(client.tokenPath));

t.section('restart is an accepted manageEngineSession action');
const { validatePublicToolInput } = await import(`file:///${ROOT}/skill/backend/tool-schemas.mjs`);
const restartValidation = validatePublicToolInput('manageEngineSession', { action: 'restart' });
t.assert('restart validates with no extra fields', restartValidation.ok,
  JSON.stringify(restartValidation.errors));
t.check('a misspelled action is still refused', validatePublicToolInput('manageEngineSession', { action: 'restartt' }).errors?.[0]?.code,
  'INVALID_ACTION');

t.section('regression: a killed host is cold started by the next tool call');
const beforeKill = await client.health();
t.assert('health reports the running host pid', Number.isInteger(beforeKill.pid), JSON.stringify(beforeKill));
// Kill the host out from under the client: this is the P0 failure mode where
// every later YGO tool call used to fail until DSH itself was restarted.
process.kill(beforeKill.pid);
let killed = false;
for (let i = 0; i < 100; i += 1) {
  if (!(await client.health()).ok) { killed = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
t.assert('the killed host stops answering /health', killed, 'the host was still healthy after process.kill');
const recoveredCall = await call('queryCards', { action: 'get', cardName: card });
t.check('an ordinary tool call succeeds without outside help', recoveredCall.ok, true);
const afterKill = await client.health();
t.check('the engine host is reachable again', afterKill.reachable, true);
t.assert('recovery started a new host process',
  Number.isInteger(afterKill.pid) && afterKill.pid !== beforeKill.pid,
  `before=${beforeKill.pid} after=${afterKill.pid}`);
t.check('the recovered host is not stale', afterKill.needsRestart, false);

t.section('regression: a cached start failure is never permanent');
// A port owned by a service that is not our host. It answers /health with a
// foreign protocol, which used to make ensureStarted throw
// ENGINE_HOST_PROTOCOL_MISMATCH on every later call, forever, even after the
// foreign service was gone: the session lost every YGO tool until DSH restarted.
const BUSY_PORT = PORT + 1;
let healthProbes = 0;
const blocker = createHttpServer((request, response) => {
  healthProbes += 1;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ ok: true, protocol: 'not-the-engine-host' }));
});
await new Promise((resolve, reject) => {
  blocker.once('error', reject);
  blocker.listen(BUSY_PORT, '127.0.0.1', resolve);
});
const blockedClient = createPersistentEngineClient({
  hostname: '127.0.0.1',
  port: BUSY_PORT,
  autoStart: true,
  startupTimeoutMs: 4000,
  serverEnv: { YGO_CACHE_DIR: join(DATA, 'cache') },
});
let firstFailure = null;
try {
  await blockedClient.listTools();
} catch (error) {
  firstFailure = error;
}
t.assert('a start against an occupied port fails', firstFailure !== null,
  'the client reported success on an occupied port');
t.check('  with the dead-host code the plugin classifies on', firstFailure?.code, 'ENGINE_HOST_FAILURE');
// The pre-fix client threw the cached protocol mismatch on the first probe and
// never looked again; a recovering client keeps probing for the whole patience
// window instead.
t.assert('the client kept probing instead of re-throwing a cached mismatch',
  healthProbes > 5, `probes=${healthProbes}`);
// A port owned by a service that is not the engine host must not be raced: the
// child spawned over it could only die on EADDRINUSE, and the caller would pay the
// whole startup budget to learn that. The failure has to name the owning service.
t.assert('the failure names the foreign service that owns the port',
  /incompatible service/i.test(firstFailure?.message ?? ''), firstFailure?.message);
const failedHealth = await blockedClient.health();
t.check('the failed probe reports the foreign service as reachable', failedHealth.reachable, true);
t.check('the failed probe asks for a restart', failedHealth.needsRestart, true);
t.check('the failed probe names the port that is occupied', failedHealth.port, BUSY_PORT);
t.assert('the failed probe carries a reason',
  typeof failedHealth.lastError === 'string' && failedHealth.lastError.length > 0, JSON.stringify(failedHealth));
// Release the port. closeAllConnections plus a capped wait keeps a pooled
// keep-alive socket from hanging the suite.
blocker.closeAllConnections?.();
await new Promise((resolve) => {
  blocker.close(() => resolve());
  setTimeout(resolve, 500);
});
// The failure is cached for a short cooldown only. After it, the same client
// must attempt a genuinely fresh cold start instead of re-throwing the cached
// error for the rest of the session.
await new Promise((resolve) => setTimeout(resolve, 1200));
t.check('the same client cold starts once the port is free', (await blockedClient.listTools()).length, 16);
t.check('the recovered host is reachable', (await blockedClient.health()).reachable, true);
await blockedClient.execute({ name: 'manageEngineSession', input: { action: 'shutdown', confirm: true } });
await new Promise((resolve) => setTimeout(resolve, 500));

t.section('restart cold starts a fresh host');
const beforeRestart = await client.health();
const restarted = await client.restart();
t.check('the host accepted the restart request', restarted.shutdownError, null);
t.check('restart leaves a reachable host', restarted.reachable, true);
t.check('restart reports the new host is not stale', restarted.needsRestart, false);
t.check('restart reports the port it restored', restarted.port, PORT);
t.check('restart reports which host it replaced', restarted.previousPid, beforeRestart.pid);
t.assert('restart replaced the host process',
  Number.isInteger(restarted.pid) && restarted.pid !== beforeRestart.pid,
  `before=${beforeRestart.pid} after=${restarted.pid}`);
t.check('a tool call works against the restarted host', (await call('manageEngineSession', { action: 'status' })).ok, true);

await call('manageEngineSession', { action: 'shutdown', confirm: true });
await new Promise((r) => setTimeout(r, 800));
rmSync(DATA, { recursive: true, force: true });

t.finish();
