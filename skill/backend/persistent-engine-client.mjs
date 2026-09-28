import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ENGINE_HOST,
  DEFAULT_ENGINE_PORT,
  ENGINE_HOST_PROTOCOL,
} from './persistent-engine-server.mjs';
import { ENGINE_TOKEN_ENV, ENGINE_TOKEN_HEADER, resolveEngineToken } from './engine-token.mjs';

const SERVER_ENTRY = fileURLToPath(new URL('./persistent-engine-server.mjs', import.meta.url));

export function createPersistentEngineClient(options = {}) {
  const hostname = readString(options.hostname ?? process.env.YGO_ENGINE_HOST) ?? DEFAULT_ENGINE_HOST;
  const port = normalizePort(options.port ?? process.env.YGO_ENGINE_HOST_PORT ?? DEFAULT_ENGINE_PORT);
  const baseUrl = `http://${hostname}:${port}`;
  const autoStart = options.autoStart !== false;
  const startupTimeoutMs = normalizeTimeout(options.startupTimeoutMs, 15000);
  // The host is spawned with process.env + serverEnv, so the token must be
  // resolved from that same effective environment: serverEnv carries
  // YGO_CACHE_DIR, which decides where the token file lives. Resolving it from
  // process.env alone would put the token somewhere the spawned host never
  // looks and authentication would silently diverge after a restart.
  const childEnv = { ...process.env, ...asRecord(options.serverEnv) };
  // Shared, persisted across DSH restarts so a fresh client can still reach a
  // detached engine host that outlived the previous plugin process.
  const engineToken = readString(options.token)
    ?? readString(childEnv[ENGINE_TOKEN_ENV])
    ?? resolveEngineToken(childEnv).token;
  let starting = null;

  async function health() {
    try {
      const result = await requestJson(`${baseUrl}/health`, { timeoutMs: 1500, token: engineToken });
      if (result.protocol !== ENGINE_HOST_PROTOCOL) {
        return { ok: false, code: 'ENGINE_HOST_PROTOCOL_MISMATCH', error: `Port ${port} is occupied by an incompatible service.` };
      }
      return result;
    } catch (error) {
      return { ok: false, code: 'ENGINE_HOST_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function ensureStarted() {
    const current = await health();
    if (current.ok) return current;
    if (current.code === 'ENGINE_HOST_PROTOCOL_MISMATCH' || !autoStart) throw new Error(current.error);
    if (!starting) {
      starting = startDetachedHost({
        hostname,
        port,
        token: engineToken,
        env: childEnv,
      }).finally(() => { starting = null; });
    }
    await starting;
    const deadline = Date.now() + startupTimeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await health();
      if (last.ok) return last;
      if (last.code === 'ENGINE_HOST_PROTOCOL_MISMATCH') throw new Error(last.error);
      await delay(75);
    }
    throw new Error(`Persistent engine host did not become ready within ${startupTimeoutMs} ms: ${last?.error ?? 'unknown error'}`);
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

  return { hostname, port, baseUrl, hasToken: Boolean(engineToken), health, ensureStarted, execute, listTools };
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
        resolve();
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

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
