// Shared engine-host authentication token.
//
// The persistent engine host listens on loopback but has no caller identity, so
// before this module any local process (or a web page issuing a form POST) could
// drive `/execute` — including starting a real duel and spawning WindBot.exe.
//
// The token must survive DSH restarts, because the engine host is deliberately
// detached and outlives the plugin. A purely random per-process token would
// break that contract (a fresh client could never talk to a surviving host), so
// the token is persisted once under the engine data root and reused:
//
//   1. an explicit `YGO_ENGINE_TOKEN` wins (tests, embedding, CI);
//   2. otherwise a token file is loaded or created under the data root;
//   3. if that file cannot be created, an ephemeral token is generated for this
//      process only — the spawning client still hands it to the child through
//      the environment, so authentication keeps working for that host.
//
// The header is not a substitute for filesystem permissions: a local process
// that can read the token file can still authenticate. It removes the
// unauthenticated remote/CSRF surface, which is the actual exposure.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const ENGINE_TOKEN_ENV = 'YGO_ENGINE_TOKEN';
export const ENGINE_TOKEN_FILE_ENV = 'YGO_ENGINE_TOKEN_FILE';
export const ENGINE_TOKEN_HEADER = 'x-ygo-engine-token';

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveEngineTokenFilePath(env = process.env) {
  const explicit = readString(env[ENGINE_TOKEN_FILE_ENV]);
  if (explicit) return resolve(explicit);
  const cacheDir = readString(env.YGO_CACHE_DIR);
  // lib/index.js lays the data root out as <dataRoot>/{cache,replays,routes,decks},
  // so the token sits next to those siblings rather than inside the cache.
  const dataRoot = cacheDir ? resolve(cacheDir, '..') : resolve(process.cwd(), '.ygo-engine');
  return join(dataRoot, 'engine-host.token');
}

/**
 * Load the shared engine token, creating it on first use.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ token: string, source: 'env' | 'file' | 'ephemeral', path: string | null }}
 */
export function resolveEngineToken(env = process.env) {
  const fromEnv = readString(env[ENGINE_TOKEN_ENV]);
  if (fromEnv) return { token: fromEnv, source: 'env', path: null };

  const path = resolveEngineTokenFilePath(env);
  const existing = readTokenFile(path);
  if (existing) return { token: existing, source: 'file', path };

  const generated = randomBytes(32).toString('hex');
  if (writeTokenFile(path, generated)) return { token: generated, source: 'file', path };
  return { token: generated, source: 'ephemeral', path: null };
}

/**
 * Constant-time comparison of a presented token against the expected one.
 *
 * @param {unknown} presented
 * @param {string} expected
 */
export function isEngineTokenValid(presented, expected) {
  if (typeof presented !== 'string' || !presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** @param {string} path */
function readTokenFile(path) {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

/** @param {string} path @param {string} token */
function writeTokenFile(path, token) {
  const staging = `${path}.partial-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(staging, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(staging, path);
    return true;
  } catch {
    try {
      rmSync(staging, { force: true });
    } catch {
      // Best effort only: the staged file may not exist.
    }
    // Another process may have won the race between read and write.
    return readTokenFile(path) !== null;
  }
}

/** @param {unknown} value */
function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
