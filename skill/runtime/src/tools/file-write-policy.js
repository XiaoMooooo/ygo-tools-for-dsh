// @ts-check
//
// Single source of truth for "may this call write a file, and where".
//
// The tools that publish files (exportSessionDeck, saveReplayYrp,
// saveRouteFile) are reachable by the model, so the target path is untrusted
// input. The policy below fails closed: a write is authorized only when the
// resolved target stays inside the output root that the operator configured
// for that operation. Caller-supplied directory overrides (replayDir,
// routeDir, ...) are accepted only when they resolve inside that same root,
// and caller-supplied file names must not climb out of it.
//
// Both the backend adapter (skill/backend/source-adapter.mjs) and the runtime
// tools (route-tools.js / replay-tools.js) call this function, so the gate
// cannot drift apart between the two entry paths again.

import { resolve } from 'node:path';

/**
 * Per-operation write contract.
 *
 * `rootKey`      configuration property that owns the output root.
 * `directoryKeys`input properties a caller may use to redirect the directory.
 * `fileNameKeys` input properties that name the file (or a relative path).
 *
 * @type {Readonly<Record<string, { rootKey: string, directoryKeys: readonly string[], fileNameKeys: readonly string[] }>>}
 */
export const WRITE_OPERATIONS = Object.freeze({
  exportSessionDeck: Object.freeze({
    rootKey: 'deckDir',
    directoryKeys: Object.freeze(['deckDir', 'directory', 'dir', 'outputDir']),
    fileNameKeys: Object.freeze(['file', 'outputPath', 'fileName']),
  }),
  saveReplayYrp: Object.freeze({
    rootKey: 'replayDir',
    directoryKeys: Object.freeze(['replayDir', 'directory', 'dir', 'outputDir']),
    fileNameKeys: Object.freeze(['fileName']),
  }),
  saveRouteFile: Object.freeze({
    rootKey: 'routeDir',
    directoryKeys: Object.freeze(['routeDir', 'directory', 'dir', 'outputDir']),
    fileNameKeys: Object.freeze(['fileName']),
  }),
});

/**
 * Authorize one file write.
 *
 * `contextOrConfig` accepts either the resolved engine configuration itself or
 * a prepared tool context (`{ session, config, ... }`); the runtime tools pass
 * the latter, the backend adapter passes the former.
 *
 * @param {unknown} contextOrConfig
 * @param {unknown} input
 * @param {string} operation
 * @returns {{ ok: true, operation: string, root: string, directory: string } | { ok: false, code: string, error: string }}
 */
export function checkFileWriteAuthorization(contextOrConfig, input, operation) {
  const spec = WRITE_OPERATIONS[operation];
  if (!spec) {
    return {
      ok: false,
      code: 'UNKNOWN_WRITE_OPERATION',
      error: `No file-write policy is registered for operation ${operation}.`,
      available: Object.keys(WRITE_OPERATIONS),
    };
  }
  const config = asRecord(asRecord(contextOrConfig).config ?? contextOrConfig);
  const configuredRoot = readNonEmptyString(config[spec.rootKey]);
  if (!configuredRoot) {
    return {
      ok: false,
      code: 'WRITE_ROOT_UNCONFIGURED',
      error: `Refusing to write: ${spec.rootKey} is not configured for ${operation}.`,
    };
  }
  const root = resolve(configuredRoot);
  const record = asRecord(input);
  let directory = root;

  for (const key of spec.directoryKeys) {
    const requested = readNonEmptyString(record[key]);
    if (!requested) continue;
    const candidate = resolve(requested);
    if (candidate !== root && !isInsideDirectory(candidate, root)) {
      return {
        ok: false,
        code: 'WRITE_PATH_ESCAPES_OUTPUT_ROOT',
        error: `${operation} refused to write outside the configured ${spec.rootKey}: ${candidate} is not inside ${root}.`,
        data: { requestedDirectory: candidate, allowedRoot: root },
      };
    }
    directory = candidate;
  }

  for (const key of spec.fileNameKeys) {
    const requested = readNonEmptyString(record[key]);
    if (!requested) continue;
    const candidate = resolve(root, requested);
    if (!isInsideDirectory(candidate, root)) {
      return {
        ok: false,
        code: 'WRITE_PATH_ESCAPES_OUTPUT_ROOT',
        error: `${operation} refused a file target outside the configured ${spec.rootKey}: ${candidate} is not inside ${root}.`,
        data: { requestedFile: requested, resolvedPath: candidate, allowedRoot: root },
      };
    }
  }

  return { ok: true, operation, root, directory };
}

/**
 * True when `targetPath` is `directory` itself or a descendant of it.
 *
 * Comparison is case-insensitive and separator-normalized because Windows
 * paths reach this code with mixed separators and casing.
 *
 * @param {string} targetPath
 * @param {string} directory
 */
export function isInsideDirectory(targetPath, directory) {
  const normalizedDirectory = normalizePathForComparison(directory);
  const normalizedTarget = normalizePathForComparison(targetPath);
  return normalizedTarget === normalizedDirectory || normalizedTarget.startsWith(`${normalizedDirectory}/`);
}

/** @param {string} targetPath */
export function normalizePathForComparison(targetPath) {
  return resolve(targetPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** @param {unknown} value */
function readNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}
