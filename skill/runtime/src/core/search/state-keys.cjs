'use strict';

const { createHash } = require('node:crypto');
const { compareStrings } = require('./action-order.cjs');

/**
 * Canonical position keys for the state-duplication measurement.
 *
 * A combo search revisits the same position over and over, and the only way to
 * size that waste before building a transposition table is to name positions
 * reproducibly. Two projections are provided on purpose, and the gap between
 * their duplicate rates *is* the signal:
 *
 *   - {@link coarseStateKey} names the visible field alone (which cards are
 *     where, LP, and the deck as a pool). It answers "same board".
 *   - {@link conservativeStateKey} adds the current legal action set. It answers
 *     "same board *and* the same options", which is what a transposition table
 *     would actually have to key on: an effect already used this turn shows up
 *     here as a smaller action set, so a board that looks identical is not the
 *     same position at all.
 *
 * The coarse key deliberately ignores deck order (the deck is a pool of cards, not
 * a sequence) while the conservative key keeps it, so every conservative key
 * belongs to exactly one coarse key and the coarse projection can only ever merge
 * positions, never split them.
 *
 * Everything here is pure: no engine access, no clock, no randomness. Ordering
 * uses code-point comparison, never `localeCompare`, so a key is identical on
 * every host. Keys are sha256 digests because they are used as `Map` keys for
 * thousands of visits and the canonical text of a full field is well over a
 * kilobyte.
 *
 * Battle position and face-up/face-down ARE part of a key, taken from the
 * per-zone card detail the runner already exposes (`p0Zones` / `p1Zones`, built
 * by `queryCards`): the engine reports them together in one `position` flag word
 * (`POS_FACEUP_ATTACK` / `POS_FACEDOWN_ATTACK` / `POS_FACEUP_DEFENSE` /
 * `POS_FACEDOWN_DEFENSE`), so a face-down set monster and the same monster face-up
 * in attack no longer hash together. Only the monster zone and the spell/trap
 * zone carry a position; hand, deck, grave, banished and extra do not, so their
 * projection is unchanged.
 *
 * Where that data is absent the key degrades honestly rather than guessing: a
 * snapshot without zone detail (or with a detail list that does not line up with
 * the code list, as the native runner's forced-empty `szone` can be) keys that
 * zone by card code alone. Two such snapshots of a position that differs only in
 * position still collide, so the strict key remains the one to trust, and a key
 * built without detail will not match one built with it.
 *
 * @module state-keys
 */

/** Zone fields of one player's visible field, in a fixed order. */
const PLAYER_FIELDS = ['mzone', 'szone', 'hand', 'grave', 'banished', 'deck', 'extra'];

/**
 * Field zones whose cards carry a battle position / face-up flag. Everything
 * else is a pool of cards with no orientation to project.
 */
const POSITIONED_FIELDS = new Set(['mzone', 'szone']);

/**
 * Coerce one zone into a list of numeric card codes.
 *
 * Anything that is not a list reads as empty, so a snapshot that omits a zone and
 * one that carries `[]` name the same position. Unknown or extra fields on the
 * snapshot are ignored by construction: the key is a projection of the visible
 * field, not a hash of whatever the engine happens to attach to it.
 *
 * @param {unknown} value
 * @returns {number[]}
 */
function toCodeList(value) {
  return Array.isArray(value) ? value.map((code) => Number(code) >>> 0) : [];
}

/**
 * The orientation token of one zone card, or an empty string when the runner did
 * not report a position for it.
 *
 * The engine packs battle position and face-up/face-down into the same flag word,
 * so one token carries both. `0` is a real (if unused) position value and is kept
 * as such; anything non-numeric is treated as "not reported" rather than coerced,
 * because a fabricated `NaN`/`0` would silently merge two different positions.
 *
 * @param {unknown} entry
 * @returns {string}
 */
function positionToken(entry) {
  const position = Number(entry?.position);
  if (!Number.isFinite(position)) return '';
  return `@${position >>> 0}`;
}

/**
 * @param {unknown} player
 * @param {unknown} detail per-zone card detail (`p0Zones` / `p1Zones`)
 * @param {string} field
 * @param {boolean} deckOrder true keeps the deck as a sequence, false as a pool
 * @returns {string}
 */
function zoneText(player, detail, field, deckOrder) {
  const codes = toCodeList(player?.[field]);
  if (field === 'deck' && !deckOrder) codes.sort((a, b) => a - b);
  const entries = POSITIONED_FIELDS.has(field) && Array.isArray(detail?.[field]) ? detail[field] : null;
  // A detail list that does not line up one-for-one with the code list cannot be
  // paired by index without inventing an alignment, so that zone falls back to
  // codes alone. This is what keeps two structurally different snapshots
  // comparable instead of producing a key that is wrong in a way nobody can see.
  if (!entries || entries.length !== codes.length) return codes.join(',');
  return codes.map((code, index) => `${code}${positionToken(entries[index])}`).join(',');
}

/**
 * @param {unknown} snapshot
 * @param {boolean} includeLp
 * @returns {string}
 */
function lpText(snapshot, includeLp) {
  if (!includeLp) return '-';
  const p0 = Number(snapshot?.lp?.p0);
  const p1 = Number(snapshot?.lp?.p1);
  return `${Number.isFinite(p0) ? p0 : 0}:${Number.isFinite(p1) ? p1 : 0}`;
}

/**
 * Canonical text of the visible field. Exported because it is the thing worth
 * eyeballing when a key does not match the position it was supposed to describe.
 *
 * @param {unknown} snapshot
 * @param {{ includeLp?: boolean, deckOrder?: boolean }} [options]
 * @returns {string}
 */
function buildFieldText(snapshot, options = {}) {
  const includeLp = options.includeLp !== false;
  const deckOrder = options.deckOrder === true;
  const players = ['p0', 'p1']
    .map((key) => {
      const detail = snapshot?.[`${key}Zones`];
      return `${key}=${PLAYER_FIELDS.map((field) => `${field}:${zoneText(snapshot?.[key], detail, field, deckOrder)}`).join('/')}`;
    })
    .join(';');
  return `lp=${lpText(snapshot, includeLp)};${players}`;
}

/**
 * Identity of one legal action inside the action set. The raw label is used, not
 * the placement-normalized one: which zone an option targets is exactly the kind
 * of difference the conservative key must keep.
 *
 * @param {{ kind?: unknown, label?: unknown }} action
 * @returns {string}
 */
function actionSetEntry(action) {
  const kind = typeof action?.kind === 'string' ? action.kind : '';
  const label = typeof action?.label === 'string' ? action.label : String(action?.label ?? '');
  return `${kind}\u0000${label}`;
}

/**
 * Canonical text of a legal action *set*. Order is engine bookkeeping, not part
 * of the position, so the entries are sorted by code point.
 *
 * @param {unknown} actions
 * @returns {string}
 */
function buildActionSetText(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return '';
  return actions.map(actionSetEntry).sort(compareStrings).join('\n');
}

/**
 * @param {string} text
 * @returns {string}
 */
function hashKeyText(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The loose key: the visible field only, with the deck read as a pool. Two
 * positions that differ only in deck order or in the options still available
 * share this key, which is what makes the coarse duplicate rate the upper bound
 * of the duplication.
 *
 * @param {unknown} snapshot
 * @param {{ includeLp?: boolean }} [options]
 * @returns {string}
 */
function coarseStateKey(snapshot, options = {}) {
  return hashKeyText(`coarse|${buildFieldText(snapshot, { includeLp: options.includeLp !== false, deckOrder: false })}`);
}

/**
 * The strict key: the full visible state plus the current legal action set.
 *
 * @param {unknown} snapshot
 * @param {unknown} actions the current legal actions, in any order
 * @param {{ includeLp?: boolean }} [options]
 * @returns {string}
 */
function conservativeStateKey(snapshot, actions, options = {}) {
  const field = buildFieldText(snapshot, { includeLp: options.includeLp !== false, deckOrder: true });
  return hashKeyText(`strict|${field}|${buildActionSetText(actions)}`);
}

module.exports = {
  buildFieldText,
  buildActionSetText,
  coarseStateKey,
  conservativeStateKey,
};
