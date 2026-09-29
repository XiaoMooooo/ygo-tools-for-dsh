import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ENGINE_HOST,
  DEFAULT_ENGINE_PORT,
  ENGINE_HOST_PROTOCOL,
} from './persistent-engine-server.mjs';
import { ENGINE_TOKEN_ENV, ENGINE_TOKEN_HEADER, resolveEngineToken, resolveEngineTokenFilePath } from './engine-token.mjs';

const SERVER_ENTRY = fileURLToPath(new URL('./persistent-engine-server.mjs', import.meta.url));

/**
 * Default cold-start budget. A host has to boot Node, import ~90 KB of backend
 * modules and open a listener; a slow, loaded machine (a shared CI runner doing
 * many things at once) does that far slower than a warm dev box. The plugin entry
 * has always defaulted to 30 s and passes that down, so 15 s only ever applied to
 * a client built without options — the case where nobody has chosen a budget and
 * where a failed first tool call is the worst outcome. A slow first call beats a
 * failed one, so the two defaults are now the same bounded number.
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
/**
 * `/health` is a loopback request whose only job is to say "someone owns this
 * port". 1500 ms was tight enough to be aborted by a host that was merely busy
 * (a sliced search legally holds the event loop for one search step at a time),
 * and a timed-out probe used to be read as "the host is gone".
 */
const HEALTH_PROBE_TIMEOUT_MS = 3000;
/**
 * How long to keep asking a host that is answering but only slowly. An alive
 * port must be re-probed for a while before anything is called unavailable: a
 * later probe can already succeed, and a host that never answers again is still
 * reported after this bound instead of hanging the caller.
 */
const HEALTH_PROBE_PATIENCE_MS = 5000;

export function createPersistentEngineClient(options = {}) {
  const hostname = readString(options.hostname ?? process.env.YGO_ENGINE_HOST) ?? DEFAULT_ENGINE_HOST;
  const port = normalizePort(options.port ?? process.env.YGO_ENGINE_HOST_PORT ?? DEFAULT_ENGINE_PORT);
  const baseUrl = `http://${hostname}:${port}`;
  const autoStart = options.autoStart !== false;
  const startupTimeoutMs = normalizeTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  // The host is spawned with process.env + serverEnv, so the token must be
  // resolved from that same effective environment: serverEnv carries
  // YGO_CACHE_DIR, which decides where the token file lives. Resolving it from
  // process.env alone would put the token somewhere the spawned host never
  // looks and authentication would silently diverge after a restart.
  const childEnv = { ...process.env, ...asRecord(options.serverEnv) };
  // Shared, persisted across DSH restarts so a fresh client can still reach a
  // detached engine host that outlived the previous plugin process.
  const envToken = readString(options.token) ?? readString(childEnv[ENGINE_TOKEN_ENV]);
  const tokenResolution = envToken ? null : resolveEngineToken(childEnv);
  const engineToken = envToken ?? tokenResolution.token;
  // Where the shared token is read from or written to, so an unreachable host
  // can be reported with the path instead of only "connection refused". It is
  // resolved even for an explicit token, because the host this client spawns
  // receives that same path through the environment.
  const tokenPath = resolveEngineTokenFilePath(childEnv);
  // A failed start must not be re-attempted by every single call (each attempt
  // costs a spawn plus the readiness wait), but it must never be cached
  // forever. After this cooldown a later call performs a fresh cold start.
  const startRetryCooldownMs = normalizeTimeout(options.startRetryCooldownMs, 1000);
  let starting = null;
  // The last failed probe/start, kept only so calls inside the cooldown fail
  // fast with the real reason. Cleared by a successful probe or an explicit
  // restart.
  let lastFailure = null;
  let lastStartAttemptAt = 0;

  function hostDiagnostics() {
    return { hostname, port, baseUrl, tokenPath };
  }

  /**
   * Probe the host and return its state plus enough diagnostics to explain a
   * failure: `{ ok, reachable, code, error, hostname, port, baseUrl, tokenPath,
   * lastError, needsRestart }`.
   *
   * Probing never starts anything; recovery happens in `ensureStarted`.
   */
  async function health() {
    try {
      const result = await requestJson(`${baseUrl}/health`, { timeoutMs: HEALTH_PROBE_TIMEOUT_MS, token: engineToken });
      if (result.protocol !== ENGINE_HOST_PROTOCOL) {
        const error = `Port ${port} is occupied by an incompatible service.`;
        return {
          ...result,
          ...hostDiagnostics(),
          ok: false,
          reachable: true,
          probeTimedOut: false,
          needsRestart: true,
          code: 'ENGINE_HOST_PROTOCOL_MISMATCH',
          error,
          lastError: error,
        };
      }
      // A host that answers /health with the right protocol is genuinely back:
      // a recorded failure must not outlive it.
      lastFailure = null;
      return {
        ...result,
        ...hostDiagnostics(),
        ok: true,
        reachable: true,
        probeTimedOut: false,
        // A reachable host that is already closing still owns the port, so it
        // must be replaced instead of reused.
        needsRestart: result.closing === true,
        lastError: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...hostDiagnostics(),
        ok: false,
        reachable: false,
        // A timeout (as opposed to a refused connection) means the port is still
        // owned by something that did not answer in time: evidence of a slow or
        // busy host, never evidence that the port is free. `ensureStarted` and
        // `startAndWait` both branch on this.
        probeTimedOut: isTimeoutError(error),
        needsRestart: true,
        code: 'ENGINE_HOST_UNAVAILABLE',
        error: message,
        // Prefer the recorded start failure: "did not become ready" is more
        // actionable than the connection error that followed it.
        lastError: lastFailure?.error ?? message,
      };
    }
  }

  async function ensureStarted() {
    const current = await health();
    if (current.ok && current.needsRestart !== true) {
      lastFailure = null;
      return current;
    }
    if (!autoStart) throw startFailure(current);
    // A probe that timed out says the port was kept open but not served within
    // the bound, which is what a host busy inside one long step looks like. Keep
    // probing briefly: a mere slow moment must not be turned into a restart (the
    // old behaviour spawned a second host over the live one, which can only die
    // on EADDRINUSE and burn the whole startup budget). Nothing is cached here,
    // so a genuine failure is still reported once this window also runs out.
    if (isProbeTimeout(current)) {
      const patient = await waitForHealthy(HEALTH_PROBE_PATIENCE_MS);
      if (patient) {
        lastFailure = null;
        return patient;
      }
    }
    // The port must be genuinely free before spawning, not merely past a fixed
    // wait: a host that is still shutting down would make the fresh process die
    // on EADDRINUSE and burn the whole startup timeout for nothing. If the port
    // is still owned after this bound, the spawn guard in startAndWait refuses
    // and reports which host is holding it, instead of racing a second one.
    if (current.reachable || current.probeTimedOut) await waitForUnreachable(2000);
    return startAndWait(current);
  }

  /**
   * Poll `/health` until it answers as usable or `timeoutMs` is spent; returns
   * the answering state or null. Used wherever "is the host up yet" has to be
   * confirmed on a machine whose speed is unknown, instead of assumed.
   */
  async function waitForHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await health();
      if (current.ok && current.needsRestart !== true) return current;
      if (Date.now() >= deadline) return null;
      await delay(50);
    }
  }

  /**
   * Cold start the host and wait until it answers, or fail with diagnostics.
   *
   * The failure is cached only for the cooldown window; every later call
   * attempts a genuinely fresh start, so a transient failure (a port still in
   * TIME_WAIT, a crashed host, an early exit) can always recover without
   * restarting DSH.
   */
  async function startAndWait(reason) {
    if (starting) {
      // Another call is already starting a host: join it instead of racing a
      // second process onto the same port.
      try {
        await starting;
      } catch {
        // The readiness loop below reports the failure with diagnostics.
      }
      return waitUntilReady(reason, null);
    }
    // Spawning is the one action that must never be taken while something still
    // owns the port: the child would die on EADDRINUSE, and the caller would pay
    // the whole startup timeout to learn that. A probe timeout is treated as an
    // occupied port rather than a free one for the same reason. `ensureStarted`
    // has already spent `HEALTH_PROBE_PATIENCE_MS` re-probing, so this window is
    // the second and final one: an answering host is used, a still-silent owner
    // is reported with the reason that named it, and a port that went away inside
    // the window is the only case that reaches a cold start.
    if (reason?.reachable || reason?.probeTimedOut) {
      const alive = await waitForHealthy(HEALTH_PROBE_PATIENCE_MS);
      if (alive) throw startFailure(alive, alive);
      throw startFailure(reason, {
        code: reason?.code ?? 'ENGINE_HOST_PORT_STILL_OWNED',
        error: `Port ${port} is still owned by a service that did not become a usable engine host, so a new one was not started: ${reason?.error ?? 'no reason reported'}`,
      });
    }
    const now = Date.now();
    if (lastFailure && now - lastStartAttemptAt < startRetryCooldownMs) {
      throw startFailure(reason, lastFailure);
    }
    lastStartAttemptAt = now;
    let exited = null;
    starting = startDetachedHost({
      hostname,
      port,
      token: engineToken,
      env: childEnv,
    }).then((child) => {
      // A host that dies while we wait (port taken, startup crash) must fail
      // fast instead of holding the caller for the whole startup timeout.
      child.once('exit', (code, signal) => { exited = { code, signal }; });
    }).finally(() => { starting = null; });
    try {
      await starting;
    } catch (error) {
      lastFailure = { at: Date.now(), code: 'ENGINE_HOST_START_FAILED', error: messageOf(error) };
      throw startFailure(reason, lastFailure);
    }
    return waitUntilReady(reason, () => exited);
  }

  async function waitUntilReady(reason, childExit) {
    const deadline = Date.now() + startupTimeoutMs;
    let last = await health();
    for (;;) {
      if (last.ok && last.needsRestart !== true) {
        lastFailure = null;
        return last;
      }
      const exit = typeof childExit === 'function' ? childExit() : null;
      if (exit) {
        lastFailure = {
          at: Date.now(),
          code: 'ENGINE_HOST_START_FAILED',
          error: `The persistent engine host exited (code ${exit.code ?? 'null'}`
            + `${exit.signal ? `, signal ${exit.signal}` : ''}) before it became ready.`,
        };
        throw startFailure(last, lastFailure);
      }
      if (Date.now() >= deadline) {
        lastFailure = {
          at: Date.now(),
          code: last.code ?? 'ENGINE_HOST_UNAVAILABLE',
          error: `Persistent engine host did not become ready within ${startupTimeoutMs} ms: ${last.error ?? 'unknown error'}`,
        };
        throw startFailure(last, lastFailure);
      }
      await delay(75);
      last = await health();
    }
  }

  async function waitForUnreachable(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await health();
      if (!current.ok && current.reachable !== true) return true;
      if (Date.now() >= deadline) return false;
      await delay(50);
    }
  }

  /**
   * Shut the host down (when it is reachable), clear every cached start/health
   * failure, then cold start a fresh host.
   *
   * This is the explicit recovery path for a host that is alive but wedged, and
   * the only path allowed to ignore the start-failure cooldown.
   */
  async function restart() {
    // Never clear the cache underneath an in-flight start: that would let two
    // hosts race onto the same port.
    if (starting) {
      try {
        await starting;
      } catch {
        // Nothing is left to shut down.
      }
    }
    const before = await health();
    let shutdownError = null;
    if (before.reachable) {
      try {
        await requestJson(`${baseUrl}/execute`, {
          method: 'POST',
          body: { call: { name: 'manageEngineSession', input: { action: 'restart' } }, sessionId: 'default' },
          token: engineToken,
          timeoutMs: 5000,
        });
      } catch (error) {
        // The host may drop the connection mid-response; that is the expected
        // end of a restart when the process exits while answering.
        shutdownError = messageOf(error);
      }
      if (!await waitForUnreachable(5000)) {
        shutdownError = shutdownError ?? `The engine host was still answering on ${baseUrl} after being asked to restart.`;
      }
    }
    starting = null;
    lastFailure = null;
    lastStartAttemptAt = 0;
    const current = await ensureStarted();
    return {
      ...current,
      restarted: true,
      previousPid: Number.isInteger(before.pid) ? before.pid : null,
      shutdownError,
    };
  }

  function startFailure(reason, failure = reason) {
    // An owned-but-unanswered port and a vanished host are different situations,
    // and the log has to say which one the caller hit. The recorded start failure
    // still wins when there is one, because "did not become ready" is the most
    // actionable reason of all.
    let message = failure?.error ?? 'Persistent engine host is unavailable.';
    if (reason?.probeTimedOut && reason?.reachable !== true && !lastFailure) {
      message = `Persistent engine host on port ${port} did not answer /health within ${HEALTH_PROBE_TIMEOUT_MS} ms: ${reason.error ?? 'unknown error'}`;
    }
    const error = new Error(message);
    // serializeEngineFailure in the plugin entry treats any code other than
    // ENGINE_HOST_FAILURE as an engine-side rejection, so a dead host must keep
    // this exact code; the detail travels in `data` instead.
    error.code = 'ENGINE_HOST_FAILURE';
    error.data = {
      engineHost: {
        ...hostDiagnostics(),
        reachable: false,
        needsRestart: true,
        lastError: error.message,
        failureCode: failure?.code ?? reason?.code ?? 'ENGINE_HOST_UNAVAILABLE',
      },
    };
    return error;
  }

  function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
  }

  async function execute(call, executeOptions = {}) {
    await ensureStarted();
    return requestJson(`${baseUrl}/execute`, {
      method: 'POST',
      body: { call, sessionId: executeOptions.sessionId ?? 'default' },
      token: engineToken,
      timeoutMs: normalizeTimeout(executeOptions.timeoutMs, 120000),
    });
  }

  async function listTools() {
    await ensureStarted();
    const result = await requestJson(`${baseUrl}/tools`, { timeoutMs: 5000, token: engineToken });
    return result.tools;
  }

  // `health` is the diagnostic probe (it never starts the host); every other
  // entry point lazy-starts it, and `restart` is the explicit shutdown + cold
  // start recovery path.
  return { hostname, port, baseUrl, tokenPath, hasToken: Boolean(engineToken), health, ensureStarted, restart, execute, listTools };
}

function startDetachedHost(options) {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(process.execPath, [SERVER_ENTRY, '--host', options.hostname, '--port', String(options.port)], {
        detached: true,
        // The host and this client must agree on address *and* token. The client
        // used to pass the address only on the command line, so a host that read
        // YGO_ENGINE_HOST_PORT from the environment could listen somewhere else
        // than the client probed, and startup would time out forever.
        env: {
          ...options.env,
          YGO_ENGINE_HOST: options.hostname,
          YGO_ENGINE_HOST_PORT: String(options.port),
          ...(options.token ? { [ENGINE_TOKEN_ENV]: options.token } : {}),
        },
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        // The caller watches for an early exit so a host that dies during
        // start-up fails fast instead of consuming the startup timeout.
        resolve(child);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function requestJson(url, options = {}) {
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.token) headers[ENGINE_TOKEN_HEADER] = options.token;
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(normalizeTimeout(options.timeoutMs, 5000)),
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Persistent engine host returned invalid JSON with HTTP ${response.status}.`);
  }
  if (!response.ok) {
    // Preserve the engine's structured failure code so the model can tell a
    // bad argument (INVALID_TOOL_INPUT) from a dead host.
    const error = new Error(value.error ?? `Persistent engine host returned HTTP ${response.status}.`);
    error.code = readString(value.code) ?? `ENGINE_HOST_HTTP_${response.status}`;
    error.status = response.status;
    if (value.data !== undefined) error.data = value.data;
    throw error;
  }
  return value;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid persistent engine host port: ${value}`);
  return port;
}

function normalizeTimeout(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? Math.trunc(timeout) : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when a failed `/health` probe failed because it ran out of time rather
 * than because nothing was listening. `fetch` reports an aborted
 * `AbortSignal.timeout` as a `TimeoutError` with a recognisable message, and a
 * socket that is accepted but never served also surfaces as a timeout. Both mean
 * the port is owned, which is the distinction the start path needs.
 */
function isTimeoutError(error) {
  if (!error) return false;
  if (error.name === 'TimeoutError') return true;
  return /aborted due to timeout|timed out|timeout/i.test(String(error.message ?? error));
}

function isProbeTimeout(state) {
  return state?.probeTimedOut === true && state?.reachable !== true;
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
