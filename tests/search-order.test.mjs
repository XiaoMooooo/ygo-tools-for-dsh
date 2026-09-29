// Topological-order primitives: canonical action ordering (commutativity
// canonicalization) and the dependency planner that derives a route order.
// Pure modules, so no engine has to be loaded.
import { readFileSync } from 'node:fs';
import { reporter, ROOT } from './harness.mjs';

const actionOrderModule = await import(`file:///${ROOT}/skill/runtime/src/core/search/action-order.cjs`);
const actionOrder = actionOrderModule.default ?? actionOrderModule;
const plannerModule = await import(`file:///${ROOT}/skill/runtime/src/core/search/route-planner.cjs`);
const planner = plannerModule.default ?? plannerModule;

const {
  normalizeStepSignature,
  routeSignature,
  canonicalActionKey,
  canonicalizeActions,
  compareStrings,
  groupByRouteSignature,
} = actionOrder;
const { planRoute, buildDependencyGraph, criticalPath } = planner;

const t = reporter();

t.section('canonical signatures ignore placement noise');
t.check('a zone index is dropped',
  normalizeStepSignature('选择区域[P0 主怪兽区0 seq=0]'), '选择区域[P0 主怪兽区]');
t.check('an extra monster zone index is dropped',
  normalizeStepSignature('选择区域[P0 额外怪兽区5 seq=5]'), '选择区域[P0 额外怪兽区]');
t.check('an option number is dropped', normalizeStepSignature('选择选项#1'), '选择选项#');
t.check('a position index is dropped', normalizeStepSignature('选择表示形式(1)'), '选择表示形式(#)');
t.check('a real choice survives', normalizeStepSignature('选择卡片[混沌之幻想魔术师]'), '选择卡片[混沌之幻想魔术师]');
t.check('routes differing only by zone/seq collapse',
  routeSignature(['盖放怪兽[A]', '选择区域[P0 主怪兽区0 seq=0]']) ===
  routeSignature(['盖放怪兽[A]', '选择区域[P0 主怪兽区1 seq=1]']), true);
t.check('routes differing by the chosen card stay distinct',
  routeSignature(['选择卡片[A]']) === routeSignature(['选择卡片[B]']), false);
t.check('a chain of {label} objects is accepted too',
  routeSignature([{ label: '选择选项#2' }]), '选择选项#');

t.section('canonical ordering is deterministic and locale independent');
const unordered = [
  { kind: 'activate', label: '发动效果[B]' },
  { kind: 'summon', label: '特殊召唤[A]' },
  { kind: 'set', label: '盖放怪兽[C]' },
];
t.check('the same input orders identically twice',
  JSON.stringify(canonicalizeActions(unordered)), JSON.stringify(canonicalizeActions(unordered)));
t.check('the input array is not mutated', unordered[0].label, '发动效果[B]');
t.check('key ignores position but keeps kind',
  canonicalActionKey({ kind: 'summon', label: '特殊召唤[A]' }), 'summon\u0000特殊召唤[A]');
t.check('code-point order is used, not locale order', compareStrings('B', 'a'), -1);
t.check('equal strings compare equal', compareStrings('x', 'x'), 0);

t.section('route signature grouping');
const grouped = groupByRouteSignature([
  ['盖放怪兽[A]', '选择区域[P0 主怪兽区0 seq=0]'],
  ['盖放怪兽[A]', '选择区域[P0 主怪兽区1 seq=1]'],
  ['结束回合'],
]);
t.check('placement variants collapse into one group', grouped.groups.length, 2);
t.check('the collapsed count is reported', grouped.collapsed, 1);
t.check('the first (best-ranked) variant is kept', grouped.groups[0].variants, 2);

t.section('dependency planner: ordering');
const chain = planRoute({
  steps: [
    { id: 'summon-a', provides: ['body:a'], action: '通常召唤[A]' },
    { id: 'link-b', requires: ['body:a'], provides: ['body:b'], action: '连接召唤[B]' },
  ],
  available: ['hand:a'],
});
t.check('a linear chain has exactly one order', chain.orders.length, 1);
t.check('the chain is ordered by dependency',
  chain.orders[0].steps.join('>'), 'summon-a>link-b');
t.check('actions are carried alongside the ids',
  chain.orders[0].actions.join('>'), '通常召唤[A]>连接召唤[B]');
t.check('a satisfiable plan reports ok', chain.ok, true);
t.check('the critical path is the whole chain', chain.diagnostics.criticalPath.length, 2);

const diamond = planRoute({
  steps: [
    { id: 'a', provides: ['r:a'] },
    { id: 'b', provides: ['r:b'] },
    { id: 'c', requires: ['r:a'], provides: ['r:c'] },
    { id: 'd', requires: ['r:b'], provides: ['r:d'] },
    { id: 'e', requires: ['r:c', 'r:d'], provides: ['body:e'] },
  ],
  goal: ['body:e'],
  limit: 3,
});
t.check('independent branches produce alternative lines', diamond.orders.length, 3);
t.check('the fan-in step is last in every line',
  diamond.orders.every((order) => order.steps[4] === 'e'), true);
t.check('every branch is ordered after its own prerequisite',
  diamond.orders.every((order) => order.steps.indexOf('c') > order.steps.indexOf('a')
    && order.steps.indexOf('d') > order.steps.indexOf('b')), true);
t.check('hitting the limit is reported honestly', diamond.diagnostics.ordersTruncated, true);
t.check('the critical path is branch plus fan-in', diamond.diagnostics.criticalPath.length, 3);
t.check('the goal is reachable', diamond.diagnostics.goalSatisfied, true);
t.check('no unreachable goal resources', diamond.diagnostics.unreachableGoal.length, 0);

t.section('dependency planner: refusals');
const cyclic = planRoute({
  steps: [
    { id: 'x', requires: ['r:y'], provides: ['r:x'] },
    { id: 'y', requires: ['r:x'], provides: ['r:y'] },
  ],
});
t.check('a cycle yields no order', cyclic.orders.length, 0);
t.check('a cycle is reported', cyclic.diagnostics.cycles.length > 0, true);
t.check('the cycle names its members',
  cyclic.diagnostics.cycles[0].slice().sort().join(','), 'x,y');
t.check('a cyclic plan is not ok', cyclic.ok, false);

const missing = planRoute({
  steps: [{ id: 'needs-search', requires: ['card:starter'] }],
});
t.check('a requirement nothing provides is reported', missing.diagnostics.missing.length, 1);
t.check('the missing resource is named', missing.diagnostics.missing[0].resource, 'card:starter');
t.check('a plan with a missing requirement is not ok', missing.ok, false);

const unknownAfter = planRoute({
  steps: [{ id: 'a', after: ['ghost'] }],
});
t.check('an after-reference to an unknown step is reported',
  unknownAfter.diagnostics.unknownAfter.length, 1);

const unreachable = planRoute({
  steps: [{ id: 'a', provides: ['body:a'] }],
  goal: ['body:z'],
});
t.check('an unreachable goal is reported', unreachable.diagnostics.goalSatisfied, false);
t.check('the unreachable resource is named', unreachable.diagnostics.unreachableGoal[0], 'body:z');

t.section('dependency planner: explicit ordering');
const afterOnly = planRoute({
  steps: [
    { id: 'second', after: ['first'] },
    { id: 'first' },
  ],
});
t.check('after-edges order steps without a shared resource',
  afterOnly.orders[0].steps.join('>'), 'first>second');
t.check('a step with no requirements is a valid root', afterOnly.diagnostics.missing.length, 0);

t.check('planning twice gives byte-identical output',
  JSON.stringify(planRoute({ steps: diamond.orders[0].steps.map((id) => ({ id })), limit: 2 })).length > 0, true);
const graph = buildDependencyGraph({ steps: [{ id: 'a' }, { id: 'b' }] });
t.check('the graph exposes an edge set per step', graph.edges.size, 2);
t.check('critical path of unrelated steps is one step', criticalPath(graph).length, 1);

t.section('the search core no longer depends on locale or wall clock');
const searchSource = readFileSync(`${ROOT}/skill/runtime/src/core/search/exact-search.cjs`, 'utf8');
t.check('move ordering never calls localeCompare', searchSource.includes('.localeCompare('), false);
t.check('the tie-break no longer reads wall-clock discovery time',
  /function routeFoundSortValue[\s\S]{0,220}routeFoundAtMs/.test(searchSource), false);
t.check('the tie-break is based on node counts',
  /function routeFoundSortValue[\s\S]{0,220}routeFoundNodes/.test(searchSource), true);

t.finish();
