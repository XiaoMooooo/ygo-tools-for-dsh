import { randomUUID } from 'node:crypto';
import { createYgoBackend } from './factory.mjs';
import { resolveEngineTokenFilePath } from './engine-token.mjs';
import {
  getPublicToolInputSchema,
  PUBLIC_TOOL_ACTIONS,
  PUBLIC_TOOL_DESCRIPTIONS,
  PUBLIC_TOOL_NAMES,
  validatePublicToolInput,
} from './tool-schemas.mjs';

export const HOST_CONTROL_TOOL_NAMES = Object.freeze([
  'manageEngineSession',
]);

// A live session holds a duel runner (WASM core state, checkpoints, and for a
// YGOPro2 duel a WindBot child process), so an engine host that never forgets a
// session grows without bound. Session keys are derived from the DSH agent id,
// which means every subagent run used to add one permanent entry.
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function resolveSessionIdleTimeoutMs(value = process.env.YGO_SESSION_IDLE_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  // 0 (or a negative value) disables reaping for long-running research sessions.
  if (parsed <= 0) return 0;
  return Math.max(parsed, 30_000);
}

export function createModelToolHost(config = {}, hostOptions = {}) {
  const backend = createYgoBackend(config);
  const sessions = new Map();
  const sessionLastUsedAt = new Map();
  const idleTimeoutMs = hostOptions.idleTimeoutMs ?? resolveSessionIdleTimeoutMs();
  // The engine server passes the address it actually listens on. The fallbacks
  // only matter for an in-process host (schema inspection), which never serves
  // a live engine call.
  const hostAddress = asRecord(hostOptions.engineHost);
  const engineHostname = readString(hostAddress.hostname)
    ?? readString(process.env.YGO_ENGINE_HOST)
    ?? '127.0.0.1';
  const enginePort = normalizeHostPort(hostAddress.port ?? process.env.YGO_ENGINE_HOST_PORT);

  /**
   * Connection facts a client can use to tell "the host answered" from "the
   * host is gone": same field names the client reports when it cannot reach
   * the host at all, so `manageEngineSession` is consistent either way.
   */
  function engineHostStatus() {
    return {
      reachable: true,
      hostname: engineHostname,
      port: enginePort,
      // Same resolution the client reports: the path the shared token is read
      // from or written to (the client hands this host its token through the
      // environment, but the persisted file is still where it lives).
      tokenPath: resolveEngineTokenFilePath(process.env),
      lastError: null,
      needsRestart: false,
    };
  }

  function touchSession(id) {
    sessionLastUsedAt.set(id, Date.now());
  }

  /**
   * Drop sessions that have not been used for `idleTimeoutMs`.
   *
   * Reaping is lazy (called before serving a call) rather than timer-driven so
   * the host never holds the event loop open just to expire sessions.
   */
  function reapIdleSessions(now = Date.now()) {
    if (!idleTimeoutMs) return [];
    const reaped = [];
    for (const [id, lastUsedAt] of sessionLastUsedAt) {
      if (now - lastUsedAt < idleTimeoutMs) continue;
      const session = sessions.get(id);
      if (session) disposeSession(session);
      sessions.delete(id);
      sessionLastUsedAt.delete(id);
      reaped.push(id);
    }
    return reaped;
  }

  function createSession(sessionId = randomUUID(), initial = {}) {
    const id = normalizeSessionId(sessionId);
    if (sessions.has(id)) throw new Error(`YGO model-tool session already exists: ${id}`);
    const session = backend.createSession(initial);
    sessions.set(id, session);
    touchSession(id);
    return { sessionId: id, session };
  }

  function ensureSession(sessionId = 'default') {
    const id = normalizeSessionId(sessionId);
    const existing = sessions.get(id);
    if (existing) {
      touchSession(id);
      return existing;
    }
    return createSession(id).session;
  }

  async function execute(call, options = {}) {
    reapIdleSessions();
    const normalized = normalizeToolCall(call);
    if (!normalized.name) {
      return { ok: false, code: 'INVALID_TOOL_CALL', error: 'Tool call requires a name.' };
    }
    if (normalized.inputError) {
      return {
        ok: false,
        code: 'INVALID_TOOL_ARGUMENTS',
        error: normalized.inputError,
        toolCallId: normalized.id,
        name: normalized.name,
      };
    }
    if (!PUBLIC_TOOL_NAMES.includes(normalized.name)) {
      return {
        ok: false,
        code: 'UNKNOWN_TOOL',
        error: `Unknown YGO model tool: ${normalized.name}`,
        toolCallId: normalized.id,
        name: normalized.name,
        availableTools: PUBLIC_TOOL_NAMES.slice(),
      };
    }
    const validation = validatePublicToolInput(normalized.name, normalized.input);
    if (!validation.ok) {
      return {
        ok: false,
        code: 'INVALID_TOOL_INPUT',
        error: `Invalid input for ${normalized.name}. ${validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join(' ')}`,
        toolCallId: normalized.id,
        name: normalized.name,
        result: { ok: false, code: 'INVALID_TOOL_INPUT', data: { errors: validation.errors } },
      };
    }
    let sessionId;
    try {
      sessionId = normalizeSessionId(options.sessionId ?? normalized.sessionId ?? 'default');
    } catch (error) {
      return {
        ok: false,
        code: 'INVALID_SESSION_ID',
        error: error instanceof Error ? error.message : String(error),
        toolCallId: normalized.id,
        name: normalized.name,
      };
    }
    if (HOST_CONTROL_TOOL_NAMES.includes(normalized.name)) {
      const result = await executeHostControl(sessionId, normalized.input);
      return {
        ok: result?.ok !== false,
        sessionId,
        toolCallId: normalized.id,
        name: normalized.name,
        result,
      };
    }
    const session = ensureSession(sessionId);
    const result = await executePublicTool(normalized.name, session, normalized.input);
    return {
      ok: result?.ok !== false,
      sessionId,
      toolCallId: normalized.id,
      name: normalized.name,
      result,
    };
  }

  async function executeHostControl(sessionId, input) {
    const action = input.action;
    if (action === 'status') {
      const session = sessions.get(sessionId) ?? null;
      return {
        ok: true,
        data: {
          sessionId,
          exists: Boolean(session),
          sessionCount: sessions.size,
          ...summarizeEngineSession(session),
          ...engineHostStatus(),
        },
      };
    }
    if (action === 'restart') {
      // A running host can only perform the shutdown half of a restart: it
      // releases its sessions and stops, and the client that asked for the
      // restart cold starts a fresh host on its next call. Doing it here keeps
      // one restart path for both the client and a direct HTTP caller.
      const clearedSessionCount = sessions.size;
      for (const session of sessions.values()) disposeSession(session);
      sessions.clear();
      const result = {
        ok: true,
        data: {
          action: 'restart-host',
          clearedSessionCount,
          ...engineHostStatus(),
          restarting: true,
          note: 'The engine host stops now; the next YGO tool call cold starts a fresh one.',
        },
      };
      if (typeof hostOptions.onShutdown === 'function') setImmediate(() => hostOptions.onShutdown(result));
      return result;
    }
    if (action !== 'clear' && action !== 'shutdown') {
      // Without this guard any unrecognized action that happened to pass the
      // confirm check used to fall through to the shutdown branch below.
      return {
        ok: false,
        code: 'INVALID_ACTION',
        error: `Unknown engine session action ${JSON.stringify(action ?? null)}.`,
        data: { availableActions: ['status', 'restart', 'clear', 'shutdown'] },
      };
    }
    if (input.confirm !== true) {
      return { ok: false, code: 'EXPLICIT_CONFIRMATION_REQUIRED', error: `${action} requires confirm:true.` };
    }
    if (action === 'clear') {
      const session = sessions.get(sessionId) ?? null;
      if (session) disposeSession(session);
      sessions.delete(sessionId);
      return {
        ok: true,
        data: { action: 'clear-session', sessionId, existed: Boolean(session), remainingSessionCount: sessions.size },
      };
    }
    const clearedSessionCount = sessions.size;
    for (const session of sessions.values()) disposeSession(session);
    sessions.clear();
    const result = { ok: true, data: { action: 'shutdown-host', clearedSessionCount } };
    if (typeof hostOptions.onShutdown === 'function') setImmediate(() => hostOptions.onShutdown(result));
    return result;
  }

  async function executePublicTool(name, session, input) {
    const context = { session, config: backend.config };
    const action = input.action;
    const payload = withoutKeys(input, 'action');
    const executeBackend = (toolName, toolInput = payload) => backend.executeTool(toolName, context, toolInput);

    // resetGame and analyzeReplay compose several internal tools, so they keep
    // explicit logic; every other action fans out through PUBLIC_TOOL_ACTIONS.
    if (name === 'resetGame') {
      if (input.fixedOpening !== undefined && input.clearFixedOpening === true) {
        return { ok: false, code: 'CONFLICTING_FIXED_OPENING', error: 'fixedOpening and clearFixedOpening cannot be used together.' };
      }
      let fixedOpeningResult = null;
      if (input.fixedOpening !== undefined) {
        fixedOpeningResult = await executeBackend('setFixedOpening', { cards: input.fixedOpening });
      } else if (input.clearFixedOpening === true) {
        fixedOpeningResult = await executeBackend('setFixedOpening', { clear: true, confirmUserRequestedClear: true });
      }
      if (fixedOpeningResult?.ok === false) return fixedOpeningResult;
      const resetResult = await executeBackend('resetGame', withoutKeys(input, 'fixedOpening', 'clearFixedOpening'));
      if (!fixedOpeningResult || resetResult?.ok === false) return resetResult;
      return {
        ...resetResult,
        data: { ...asRecord(resetResult.data), fixedOpening: fixedOpeningResult.data },
      };
    }

    if (name === 'analyzeReplay') {
      if (action === 'context') return executeBackend('buildRouteContext');
      const parsed = await executeBackend('parseYrpRoute');
      if (parsed?.ok === false || action === 'parse') {
        if (parsed?.ok) rememberParsedReplay(session, parsed.data);
        return parsed;
      }
      rememberParsedReplay(session, parsed.data);
      const contextResult = await executeBackend('buildRouteContext', asRecord(parsed.data));
      if (contextResult?.ok === false) return contextResult;
      return { ok: true, data: { parsed: parsed.data, context: contextResult.data } };
    }

    const actions = PUBLIC_TOOL_ACTIONS[name];
    // Tools with no action table entry take no `action` argument and run
    // themselves (getBanlistContext, executeAction, simulateActions).
    if (!actions) return executeBackend(name, input);

    const entry = actions[action];
    if (!entry) {
      // validatePublicToolInput rejects this first; the guard stays so a direct
      // caller can never fall through to a silently different tool.
      return {
        ok: false,
        code: 'INVALID_ACTION',
        error: `Unknown action ${JSON.stringify(action ?? null)} for ${name}.`,
        data: { availableActions: Object.keys(actions) },
      };
    }
    return executeBackend(entry.tool);
  }

  const listToolSchemas = () => PUBLIC_TOOL_NAMES.map((name) => ({
      name,
      description: PUBLIC_TOOL_DESCRIPTIONS[name],
      input_schema: getPublicToolInputSchema(name),
    }));

  return {
    backend,
    sessions,
    idleTimeoutMs,
    createSession,
    ensureSession,
    getSession: (sessionId = 'default') => {
      const id = normalizeSessionId(sessionId);
      const session = sessions.get(id);
      if (session) touchSession(id);
      return session ?? null;
    },
    listSessions: () => [...sessions.keys()],
    hasSession: (sessionId) => sessions.has(normalizeSessionId(sessionId)),
    deleteSession: (sessionId) => {
      const id = normalizeSessionId(sessionId);
      const session = sessions.get(id);
      if (session) disposeSession(session);
      sessionLastUsedAt.delete(id);
      return sessions.delete(id);
    },
    clearSessions: () => {
      for (const session of sessions.values()) disposeSession(session);
      sessions.clear();
      sessionLastUsedAt.clear();
    },
    reapIdleSessions,
    listTools: () => listToolSchemas(),
    execute,
  };
}

function withoutKeys(value, ...keys) {
  const output = { ...asRecord(value) };
  for (const key of keys) delete output[key];
  return output;
}

function rememberParsedReplay(session, parsed) {
  if (!session || typeof session.mergeMetadata !== 'function') return;
  session.mergeMetadata({
    lastParsedYrpRoute: parsed,
    lastParsedYrpRouteUpdatedAt: new Date().toISOString(),
  });
}

function summarizeEngineSession(session) {
  if (!session) {
    return { hasRunner: false, loadedDeckName: null, checkpointCount: 0, messageCount: 0 };
  }
  const metadata = asRecord(session.metadata);
  return {
    hasRunner: Boolean(session.runner),
    duelBackend: readString(asRecord(session.runner).duelBackend) ?? readString(metadata.duelBackend) ?? null,
    ygoPro2Bridge: typeof asRecord(session.runner).getBridgeStatus === 'function'
      ? asRecord(session.runner).getBridgeStatus()
      : null,
    loadedDeckName: readString(metadata.currentDeckName),
    checkpointCount: Array.isArray(metadata.exploreCheckpoints) ? metadata.exploreCheckpoints.length : 0,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
  };
}

function disposeSession(session) {
  const runner = asRecord(session?.runner);
  try {
    if (typeof runner.destroyDuel === 'function') runner.destroyDuel();
    else if (typeof asRecord(runner.duel).endDuel === 'function') asRecord(runner.duel).endDuel();
  } catch {
    // Clearing state must remain best-effort even after a native runner failure.
  }
  if (session && typeof session === 'object') session.runner = null;
}

export function normalizeToolCall(call) {
  const record = asRecord(call);
  const name = readString(record.name);
  const rawInput = record.input ?? record.arguments ?? {};
  const parsed = parseArguments(rawInput);
  return {
    id: readString(record.id) ?? readString(record.tool_call_id),
    sessionId: readString(record.sessionId) ?? readString(record.session_id),
    name,
    input: parsed.value,
    inputError: parsed.error,
  };
}

function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { value, error: null };
  if (typeof value !== 'string' || !value.trim()) return { value: {}, error: null };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { value: parsed, error: null }
      : { value: {}, error: 'Tool arguments JSON must decode to an object.' };
  } catch {
    return { value: {}, error: 'Tool arguments must be a JSON object or an object value.' };
  }
}

function normalizeSessionId(value) {
  const id = readString(value);
  if (!id) throw new Error('YGO model-tool session id must be a non-empty string.');
  return id;
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeHostPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
