'use strict';

/**
 * Dependency planner for combo routes.
 *
 * The search core walks the engine's action graph depth-first: it can tell you
 * which sequences the engine *allows*, but it cannot tell you why one step has to
 * come before another, whether a target is reachable at all, or how many steps
 * the shortest line needs. Those are dependency questions, and they are answered
 * by building an explicit DAG and ordering it.
 *
 * A plan is declarative: each step says what it `requires`, what it `provides`,
 * and optionally what it must come `after`. Resources already in hand (the opening
 * hand, the field) go in `available`. The planner then:
 *
 *   1. links each requirement to the steps that provide it,
 *   2. orders the result with Kahn's algorithm,
 *   3. enumerates a bounded number of *valid* linear extensions (alternative
 *      lines) with a deterministic tie-break,
 *   4. reports the ways the graph cannot be ordered — cycles (which is exactly why
 *      a topological order is not always available), requirements nothing
 *      provides, and `after` references to unknown steps,
 *   5. computes the critical path, i.e. the fewest steps any line needs.
 *
 * Nothing here touches the engine: the output is a candidate order that still has
 * to be executed step by step and verified. It is pure, so it is unit-testable
 * without loading ocgcore.
 *
 * @module route-planner
 */

const { compareStrings } = require('./action-order.cjs');

const DEFAULT_ORDER_LIMIT = 5;
const DEFAULT_MAX_EXPANSIONS = 20000;

/** @param {unknown} value */
function toArray(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function readString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** @param {unknown} value */
function readResourceList(value) {
  return toArray(value).map(readString).filter((entry) => entry !== null);
}

/**
 * @param {unknown} steps
 * @returns {{ list: Array<object>, problems: Array<object> }}
 */
function normalizeSteps(steps) {
  const list = [];
  const problems = [];
  const seen = new Set();
  for (const raw of toArray(steps)) {
    const id = readString(raw?.id);
    if (!id) {
      problems.push({ code: 'STEP_WITHOUT_ID' });
      continue;
    }
    if (seen.has(id)) {
      problems.push({ code: 'DUPLICATE_STEP_ID', step: id });
      continue;
    }
    seen.add(id);
    list.push({
      id,
      action: readString(raw?.action) ?? id,
      requires: readResourceList(raw?.requires),
      provides: readResourceList(raw?.provides),
      after: readResourceList(raw?.after),
      priority: Number.isFinite(Number(raw?.priority)) ? Number(raw.priority) : 0,
    });
  }
  return { list, problems };
}

/**
 * Build the dependency graph. An edge `a -> b` means step `a` must run before
 * step `b`, either because `a` provides something `b` requires, or because `b`
 * declares `after: [a]`.
 *
 * @param {{ steps?: unknown, available?: unknown }} [input]
 */
function buildDependencyGraph(input = {}) {
  const { list, problems } = normalizeSteps(input.steps);
  const byId = new Map(list.map((step) => [step.id, step]));
  const available = new Set(readResourceList(input.available));
  const edges = new Map(list.map((step) => [step.id, new Set()]));
  const producers = new Map();
  const missing = [];
  const unknownAfter = [];

  for (const step of list) {
    for (const resource of step.provides) {
      if (!producers.has(resource)) producers.set(resource, []);
      producers.get(resource).push(step.id);
    }
  }

  for (const step of list) {
    for (const resource of step.requires) {
      if (available.has(resource)) continue;
      const sources = producers.get(resource) ?? [];
      if (sources.length === 0) {
        missing.push({ step: step.id, resource });
        continue;
      }
      for (const source of sources) {
        if (source !== step.id) edges.get(source).add(step.id);
      }
    }
    for (const dependency of step.after) {
      if (!byId.has(dependency)) {
        unknownAfter.push({ step: step.id, after: dependency });
        continue;
      }
      if (dependency !== step.id) edges.get(dependency).add(step.id);
    }
  }

  const indegree = new Map(list.map((step) => [step.id, 0]));
  for (const targets of edges.values()) {
    for (const target of targets) indegree.set(target, indegree.get(target) + 1);
  }

  return {
    ids: list.map((step) => step.id),
    byId,
    edges,
    indegree,
    available,
    producers,
    missing,
    unknownAfter,
    problems,
  };
}

/**
 * Deterministic frontier order: lower `priority` first, then step id by code point.
 *
 * @param {ReturnType<typeof buildDependencyGraph>} graph
 * @param {string} a
 * @param {string} b
 */
function compareReadySteps(graph, a, b) {
  const priorityDelta = (graph.byId.get(a)?.priority ?? 0) - (graph.byId.get(b)?.priority ?? 0);
  return priorityDelta !== 0 ? priorityDelta : compareStrings(a, b);
}

/**
 * One canonical topological order (Kahn). Returns the steps that could not be
 * ordered, which are the ones involved in cycles.
 *
 * @param {ReturnType<typeof buildDependencyGraph>} graph
 * @returns {{ order: string[], unordered: string[] }}
 */
function kahnOrder(graph) {
  const indegree = new Map(graph.indegree);
  const ready = graph.ids.filter((id) => indegree.get(id) === 0).sort((a, b) => compareReadySteps(graph, a, b));
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const target of graph.edges.get(id)) {
      const remaining = indegree.get(target) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
        ready.sort((a, b) => compareReadySteps(graph, a, b));
      }
    }
  }
  return { order, unordered: graph.ids.filter((id) => !order.includes(id)) };
}

/**
 * Find concrete cycles among the steps Kahn could not order.
 *
 * @param {ReturnType<typeof buildDependencyGraph>} graph
 * @returns {string[][]} up to a handful of cycles, each listing step ids
 */
function findCycles(graph) {
  const { unordered } = kahnOrder(graph);
  if (unordered.length === 0) return [];
  const pending = new Set(unordered);
  const cycles = [];
  const state = new Map();
  const path = [];

  const visit = (id) => {
    if (cycles.length >= 5) return;
    state.set(id, 'visiting');
    path.push(id);
    for (const target of graph.edges.get(id) ?? []) {
      if (!pending.has(target)) continue;
      const status = state.get(target);
      if (status === 'visiting') {
        const start = path.indexOf(target);
        cycles.push(path.slice(start >= 0 ? start : 0));
        continue;
      }
      if (status === undefined) visit(target);
    }
    path.pop();
    state.set(id, 'done');
  };

  for (const id of unordered) {
    if (state.get(id) === undefined) visit(id);
    if (cycles.length >= 5) break;
  }
  return cycles;
}

/**
 * Enumerate valid linear extensions (alternative lines) in a deterministic order,
 * bounded by `limit` results and `maxExpansions` search steps.
 *
 * @param {ReturnType<typeof buildDependencyGraph>} graph
 * @param {{ limit?: number, maxExpansions?: number }} [options]
 */
function topologicalOrders(graph, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.trunc(Number(options.limit))
    : DEFAULT_ORDER_LIMIT;
  const maxExpansions = Number.isFinite(Number(options.maxExpansions)) && Number(options.maxExpansions) > 0
    ? Math.trunc(Number(options.maxExpansions))
    : DEFAULT_MAX_EXPANSIONS;

  const orders = [];
  let expansions = 0;
  let truncated = false;
  const order = [];

  const walk = (ready, indegree) => {
    if (orders.length >= limit || truncated) return;
    if (order.length === graph.ids.length) {
      orders.push(order.slice());
      return;
    }
    for (const id of ready) {
      if (orders.length >= limit || truncated) return;
      if (expansions >= maxExpansions) {
        truncated = true;
        return;
      }
      expansions += 1;
      const nextIndegree = new Map(indegree);
      const nextReady = ready.filter((entry) => entry !== id);
      for (const target of graph.edges.get(id)) {
        const remaining = nextIndegree.get(target) - 1;
        nextIndegree.set(target, remaining);
        if (remaining === 0) nextReady.push(target);
      }
      nextReady.sort((a, b) => compareReadySteps(graph, a, b));
      order.push(id);
      walk(nextReady, nextIndegree);
      order.pop();
    }
  };

  walk(
    graph.ids.filter((id) => graph.indegree.get(id) === 0).sort((a, b) => compareReadySteps(graph, a, b)),
    new Map(graph.indegree),
  );

  return { orders, truncated, expansions, cycles: orders.length === 0 ? findCycles(graph) : [] };
}

/**
 * Fewest steps any valid line needs, i.e. the longest dependency chain.
 *
 * @param {ReturnType<typeof buildDependencyGraph>} graph
 * @returns {{ length: number, steps: string[] }}
 */
function criticalPath(graph) {
  const { order } = kahnOrder(graph);
  const distance = new Map(graph.ids.map((id) => [id, 0]));
  const previous = new Map();
  for (const id of order) {
    for (const target of graph.edges.get(id) ?? []) {
      if (distance.get(id) + 1 > distance.get(target)) {
        distance.set(target, distance.get(id) + 1);
        previous.set(target, id);
      }
    }
  }
  let end = null;
  for (const id of order) {
    if (end === null || distance.get(id) > distance.get(end)) end = id;
  }
  const steps = [];
  for (let cursor = end; cursor !== undefined; cursor = previous.get(cursor)) steps.unshift(cursor);
  return { length: steps.length, steps };
}

/**
 * Plan a route: order the declared steps, enumerate alternative valid lines, and
 * report everything that stands in the way.
 *
 * @param {{ steps?: unknown, available?: unknown, goal?: unknown, limit?: number, maxExpansions?: number }} [input]
 */
function planRoute(input = {}) {
  const graph = buildDependencyGraph(input);
  const { orders, truncated, expansions, cycles } = topologicalOrders(graph, {
    limit: input.limit,
    maxExpansions: input.maxExpansions,
  });
  const goal = readResourceList(input.goal);
  const reachable = new Set(graph.available);
  for (const step of graph.byId.values()) for (const resource of step.provides) reachable.add(resource);

  return {
    ok: cycles.length === 0 && graph.missing.length === 0 && graph.problems.length === 0,
    orders: orders.map((ids) => ({
      steps: ids,
      actions: ids.map((id) => graph.byId.get(id).action),
    })),
    diagnostics: {
      cycles,
      missing: graph.missing,
      unknownAfter: graph.unknownAfter,
      problems: graph.problems,
      goal,
      goalSatisfied: goal.length === 0 ? null : goal.every((resource) => reachable.has(resource)),
      unreachableGoal: goal.filter((resource) => !reachable.has(resource)),
      initialResources: [...graph.available],
      providedResources: [...reachable].sort(compareStrings),
      criticalPath: criticalPath(graph),
      // True when the enumeration stopped early — either the expansion cap was hit
      // or the caller's limit was reached, which means more lines may exist.
      ordersTruncated: truncated || orders.length >= (Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 5),
      expansions,
      stepCount: graph.ids.length,
    },
  };
}

module.exports = {
  planRoute,
  buildDependencyGraph,
  topologicalOrders,
  criticalPath,
  findCycles,
  kahnOrder,
};
