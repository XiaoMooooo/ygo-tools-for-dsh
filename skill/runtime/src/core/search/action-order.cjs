'use strict';

/**
 * Canonical ordering primitives shared by the combo search and the route planner.
 *
 * The search is a plain depth-first walk with a static move ordering, and its
 * cycle/repeat detection keys on action sequences. Both suffer from the same root
 * problem: two action sequences that differ only in *placement noise* (which zone
 * index a card went to, which option number was picked) or only in the order of
 * mutually independent actions look different to a string comparison, so they are
 * explored, ranked and reported as if they were distinct lines.
 *
 * Ties are broken by code-point comparison rather than `localeCompare`, so the
 * ordering does not depend on the host locale or the ICU version.
 *
 * @module action-order
 */

/** Placement/selection noise that says *where* something happened, not *what*. */
const PLACEMENT_NOISE = [
  [/\s*seq=\d+/g, ''],
  [/#\d+/g, '#'],
  [/\(\d+\)/g, '(#)'],
  [/(怪兽区|魔法与陷阱区|墓地|手牌|卡组|除外|场上|额外)\d+/g, '$1'],
];

/**
 * Reduce a label to what the action actually does, dropping placement noise.
 *
 * @param {unknown} label
 * @returns {string}
 */
function normalizeStepSignature(label) {
  let text = String(label ?? '');
  for (const [pattern, replacement] of PLACEMENT_NOISE) text = text.replace(pattern, replacement);
  return text.trim();
}

/**
 * Canonical signature of a whole route. Accepts either the search core's chain of
 * label strings or a list of `{ label }` objects.
 *
 * @param {unknown} chain
 * @returns {string}
 */
function routeSignature(chain) {
  if (!Array.isArray(chain)) return '';
  return chain
    .map((entry) => normalizeStepSignature(typeof entry === 'string' ? entry : entry?.label))
    .join(' > ');
}

/**
 * Stable identity of a single action, independent of its position in a list.
 *
 * @param {{ kind?: unknown, label?: unknown }} action
 * @returns {string}
 */
function canonicalActionKey(action) {
  const kind = typeof action?.kind === 'string' ? action.kind : '';
  return `${kind}\u0000${normalizeStepSignature(action?.label)}`;
}

/**
 * Locale-independent string comparison: code-point order, so the result is the
 * same on every host. Use this instead of `localeCompare` wherever a tie-break
 * must be reproducible.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
function compareStrings(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Order a set of mutually independent actions canonically: by what they do, then
 * by the raw label. Two runs over the same set always produce the same array.
 *
 * This is the "commutativity canonicalization" step: when the engine offers
 * several actions that do not depend on each other's outcome, any permutation is
 * a valid line, and picking one representative deterministically is what lets
 * deduplication and reproducible ranking work at all.
 *
 * @param {Array<{ kind?: unknown, label?: unknown }>} actions
 * @returns {Array<unknown>}
 */
function canonicalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) =>
      compareStrings(canonicalActionKey(left.action), canonicalActionKey(right.action)) ||
      compareStrings(left.action?.label, right.action?.label) ||
      left.index - right.index)
    .map((entry) => entry.action);
}

/**
 * Group route labels by canonical signature, keeping the first occurrence of each
 * group (the caller passes an already-ranked list, so the first is the best).
 *
 * @param {Array<unknown>} chains ordered best-first
 * @returns {{ groups: Array<{ signature: string, chain: unknown, variants: number }>, collapsed: number }}
 */
function groupByRouteSignature(chains) {
  const groups = new Map();
  for (const chain of Array.isArray(chains) ? chains : []) {
    const signature = routeSignature(chain);
    const existing = groups.get(signature);
    if (existing) {
      existing.variants += 1;
      continue;
    }
    groups.set(signature, { signature, chain, variants: 1 });
  }
  const list = [...groups.values()];
  return { groups: list, collapsed: (Array.isArray(chains) ? chains.length : 0) - list.length };
}

module.exports = {
  normalizeStepSignature,
  routeSignature,
  canonicalActionKey,
  canonicalizeActions,
  compareStrings,
  groupByRouteSignature,
};
