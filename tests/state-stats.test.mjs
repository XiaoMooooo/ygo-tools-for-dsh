// State-duplication statistics: measurement only, and provably neutral.
//
// A combo search revisits the same position over and over (a prior measurement put
// roughly 40 % of the node budget on an already-seen position, worst case one
// position entered 12 times). Before anyone builds a transposition table that
// prunes on those numbers, the numbers have to be honest:
//
//   1. a zero has to mean "no duplicates", never "not measured" — which is exactly
//      what happened when terminals were left out of the visit hook and the report
//      said `terminalVisits: 0`;
//   2. the statistics must not move a single search decision, so the same seed with
//      `measureStates` off and on has to return the same routes.
//
// Both are checked against a real engine search at a small node budget, so this
// suite stays a few seconds long.
import { readFileSync } from 'node:fs';
import { reporter, ROOT } from './harness.mjs';

const t = reporter();

const keysModule = await import(`file:///${ROOT}/skill/runtime/src/core/search/state-keys.cjs`);
const keys = keysModule.default ?? keysModule;
const { coarseStateKey, conservativeStateKey, buildFieldText } = keys;
const { PUBLIC_TOOL_NAMES, validatePublicToolInput } = await import(`file:///${ROOT}/skill/backend/tool-schemas.mjs`);
const { createSourceAdapter, describeStateStatistics } = await import(`file:///${ROOT}/skill/backend/source-adapter.mjs`);

/** A snapshot in the engine's own shape, with a bit of engine bookkeeping attached. */
function snapshot(overrides = {}) {
  return {
    lp: { p0: 8000, p1: 8000 },
    p0: {
      mzone: [111],
      szone: [],
      hand: [1, 2, 3],
      grave: [],
      banished: [],
      deck: [9, 8, 7],
      extra: [5],
      ...overrides.p0,
    },
    p1: {
      mzone: [],
      szone: [],
      hand: [],
      grave: [],
      banished: [],
      deck: [4, 6],
      extra: [],
      ...overrides.p1,
    },
    ...overrides.root,
  };
}

const base = snapshot();
const shuffledDeck = snapshot({ p0: { deck: [7, 9, 8] } });
const damaged = snapshot({ root: { lp: { p0: 7000, p1: 8000 } } });
const lostACard = snapshot({ p0: { hand: [1, 2] } });
const withEngineNoise = { ...snapshot(), revision: 42, debugSeq: 7, p0Zones: { mzone: [{ code: 111, level: 4 }] } };
const missingZones = snapshot({ p0: { szone: null, grave: undefined } });
const twoActions = [{ kind: 'activate', label: 'A' }, { kind: 'summon', label: 'B' }];
const twoActionsReordered = [{ kind: 'summon', label: 'B' }, { kind: 'activate', label: 'A' }];
const oneAction = [{ kind: 'summon', label: 'B' }];
const zoneChoiceA = [{ kind: 'set', label: '选择区域[P0 主怪兽区0 seq=0]' }];
const zoneChoiceB = [{ kind: 'set', label: '选择区域[P0 主怪兽区1 seq=1]' }];
// The engine reports battle position and face-up/face-down in one flag word
// (`POS_FACEUP_ATTACK` = 1, `POS_FACEDOWN_DEFENSE` = 8), and the runner exposes it
// per zone card as `p0Zones.mzone[i].position`. The keys have to read it: a set
// monster and the same monster face-up in attack are not the same position.
const faceUpAttack = snapshot({ root: { p0Zones: { mzone: [{ code: 111, position: 1 }] } } });
const faceUpDefense = snapshot({ root: { p0Zones: { mzone: [{ code: 111, position: 4 }] } } });
const faceDownDefense = snapshot({ root: { p0Zones: { mzone: [{ code: 111, position: 8 }] } } });
const positionNotReported = snapshot({ root: { p0Zones: { mzone: [{ code: 111, level: 4 }] } } });
const mismatchedDetail = snapshot({ root: { p0Zones: { mzone: [] } } });
const handDetailOnly = snapshot({ root: { p0Zones: { hand: [{ code: 1, position: 1 }, { code: 2, position: 1 }, { code: 3, position: 1 }] } } });

t.section('the strict key is the field plus the legal action set');
t.check('the same position and the same options give the same key',
  conservativeStateKey(base, twoActions), conservativeStateKey(base, twoActions));
// The "an effect was already used this turn" signal: the board looks identical, but
// the option it would have offered is gone, so it is not the same position.
t.check('  a smaller action set on that board is a different key',
  conservativeStateKey(base, twoActions) === conservativeStateKey(base, oneAction), false);
t.check('the order of the offered actions is engine bookkeeping, not the position',
  conservativeStateKey(base, twoActions), conservativeStateKey(base, twoActionsReordered));
t.check('which zone an option targets still counts',
  conservativeStateKey(base, zoneChoiceA) === conservativeStateKey(base, zoneChoiceB), false);
t.check('a different board with the same options is a different key',
  conservativeStateKey(base, twoActions) === conservativeStateKey(lostACard, twoActions), false);

t.section('the coarse key is the visible field alone');
t.check('deck order does not affect the coarse key',
  coarseStateKey(base), coarseStateKey(shuffledDeck));
t.check('deck order does affect the strict key',
  conservativeStateKey(base, twoActions) === conservativeStateKey(shuffledDeck, twoActions), false);
t.check('LP is part of the position',
  coarseStateKey(base) === coarseStateKey(damaged), false);
t.check('  unless the caller asks for a position without it',
  coarseStateKey(base, { includeLp: false }), coarseStateKey(damaged, { includeLp: false }));
t.check('the field projection really is the field',
  /^lp=8000:8000;.*mzone:111/.test(buildFieldText(base)), true);

t.section('battle position and face-up state are part of a key');
// The defect this pins: the key used to project card codes only, so a face-down
// set monster and the same monster face-up in attack hashed together. The runner
// does expose the flag (`p0Zones.mzone[i].position`), so the key reads it.
t.check('a face-down set monster is not the same position as a face-up attacker',
  coarseStateKey(faceUpAttack) === coarseStateKey(faceDownDefense), false);
t.check('  and the strict key separates them too',
  conservativeStateKey(faceUpAttack, twoActions) === conservativeStateKey(faceDownDefense, twoActions), false);
t.check('battle position alone is enough to separate two identical boards',
  coarseStateKey(faceUpAttack) === coarseStateKey(faceUpDefense), false);
t.check('the flag word is projected verbatim',
  /mzone:111@1/.test(buildFieldText(faceUpAttack)), true);
t.check('  and the defense position keeps its own value',
  /mzone:111@4/.test(buildFieldText(faceUpDefense)), true);
t.check('the coarse key still ignores deck order with positions present',
  coarseStateKey(faceUpAttack), coarseStateKey(snapshot({
    root: { p0Zones: { mzone: [{ code: 111, position: 1 }] } },
    p0: { deck: [7, 9, 8] },
  })));
t.check('a zone with no reported position keys by code alone',
  coarseStateKey(base), coarseStateKey(positionNotReported));
t.check('a zone whose detail does not line up with its codes falls back to codes',
  coarseStateKey(base), coarseStateKey(mismatchedDetail));
t.check('zones that have no orientation are not given one',
  coarseStateKey(base), coarseStateKey(handDetailOnly));
t.check('  which is what keeps the projected field text unchanged for them',
  /hand:1,2,3/.test(buildFieldText(handDetailOnly)), true);

t.section('key noise is ignored by construction');
t.check('engine bookkeeping on the snapshot does not change the coarse key',
  coarseStateKey(base), coarseStateKey(withEngineNoise));
t.check('engine bookkeeping on the snapshot does not change the strict key',
  conservativeStateKey(base, twoActions), conservativeStateKey(withEngineNoise, twoActions));
t.check('an absent zone and an empty zone are the same position',
  coarseStateKey(base), coarseStateKey(missingZones));
t.check('a key is a fixed-width digest',
  /^[0-9a-f]{64}$/.test(coarseStateKey(base)), true);
// Same reason the search core is held to this: a locale-dependent comparison
// would make the same position hash differently on another host.
const keySource = readFileSync(`${ROOT}/skill/runtime/src/core/search/state-keys.cjs`, 'utf8');
t.check('key ordering never calls localeCompare', keySource.includes('.localeCompare('), false);
t.check('key ordering uses the shared code-point comparison', keySource.includes('compareStrings'), true);

t.section('the adapter exposes the statistics wiring');
const adapter = createSourceAdapter({});
const registeredKeys = await adapter.loadModule('stateKeys');
const registered = registeredKeys.default ?? registeredKeys;
t.check('the pure key module is registered in CORE_MODULES',
  typeof registered.coarseStateKey, 'function');
t.check('  with the strict key too', typeof registered.conservativeStateKey, 'function');
t.check('the public tool count is unchanged', PUBLIC_TOOL_NAMES.length, 16);
t.check('measureStates is a valid expandCombo input',
  validatePublicToolInput('expandCombo', { ydk: 'x', measureStates: true }).ok, true);
t.check('  and it still rejects a wrong type',
  validatePublicToolInput('expandCombo', { ydk: 'x', measureStates: 'yes' }).ok, false);
t.check('  and it is still strictly validated',
  validatePublicToolInput('expandCombo', { ydk: 'x', bogus: 1 }).ok, false);
t.check('a statistics note is human readable',
  describeStateStatistics({ topK: { routes: 10, distinctTerminals: 4, largestVariants: 3 } }),
  '10 routes land on 4 distinct terminals; the largest group has 3 that differ only in order.');
t.check('  singular wording stays grammatical',
  describeStateStatistics({ topK: { routes: 1, distinctTerminals: 1, largestVariants: 1 } }),
  '1 route lands on 1 distinct terminal.');
t.check('  and an empty search says so',
  describeStateStatistics({ topK: { routes: 0, distinctTerminals: 0, largestVariants: 0 } }),
  'No route reached a terminal, so there is nothing to group.');

t.section('parallel search is reported, never silently disabled');
// `targetTerminals > 0` disables the sharded parallel backend outright, and it used
// to do so silently. The decision is a descriptor now, and the boolean the runtime
// branches on is derived from it, so a reported reason can never disagree with the
// decision actually taken.
const { createExactParallelRuntimeApi } = await import(`file:///${ROOT}/skill/runtime/src/runtime/exact-parallel-runtime.cjs`);
const parallelApi = createExactParallelRuntimeApi({ process, os: await import('node:os') });
const parallelJob = (overrides = {}) => ({
  exactSingleSearch: true,
  engineBackend: 'wasm',
  exactSearchBackend: 'parallel-js',
  workers: 4,
  targetTerminals: 0,
  ...overrides,
});
const parallelOf = (overrides) => parallelApi.describeParallelExactSearch(parallelJob(overrides));
t.check('a plain parallel request is active', parallelOf().active, true);
t.check('  and needs no reason', parallelOf().disabledReason, null);
t.check('a targetTerminals request is refused the parallel path', parallelOf({ targetTerminals: 5 }).active, false);
t.check('  with the reason named', parallelOf({ targetTerminals: 5 }).disabledReason, 'target-terminals');
t.check('  while still saying parallel was requested', parallelOf({ targetTerminals: 5 }).requested, true);
t.check('the boolean decision agrees with the descriptor',
  parallelApi.shouldUseParallelExactSearch(parallelJob({ targetTerminals: 5 })), false);
t.check('  on the active side too', parallelApi.shouldUseParallelExactSearch(parallelJob()), true);
t.check('one worker is not a parallel request', parallelOf({ workers: 1 }).requested, false);
t.check('  and is not reported as a disabled one', parallelOf({ workers: 1 }).disabledReason, null);
t.check('the serial js backend is not a parallel request',
  parallelOf({ exactSearchBackend: 'js' }).requested, false);
t.check('a native-engine search is not a parallel request',
  parallelOf({ engineBackend: 'native' }).requested, false);
t.check('an incomparable resume state disables it',
  parallelOf({ resumeState: { resumeVersion: 1, stack: [] } }).disabledReason, 'incompatible-resume-state');
t.check('an already split shard set disables it',
  parallelOf({ exactShards: [{ shardId: 1 }] }).disabledReason, 'pre-split-shards');

t.section('a real search, measured and then measured again');
// A fixed opening chosen because its top-K genuinely contains two routes that land
// on the same terminal; 60 nodes keeps the suite fast while still settling 11
// terminals. Same input for both runs, so the only difference is the flag.
//
// Both runs go through the adapter, not straight to the simulator: that is what
// exercises the schema, the `statistics` block and the note in one go.
const statsSession = adapter.createSession({ sessionId: 'state-stats' });
const FIXED_OPENING = [10966439, 68810435, 4215180, 31425736, 93360904];
const SEARCH_INPUT = {
  ydk: readFileSync(`${ROOT}/skill/resources/lib/slm.ydk`, 'utf8'),
  openingCodes: FIXED_OPENING,
  seed: 4242,
  maxNodes: 60,
  maxDepth: 40,
  topK: 8,
};
const off = await adapter.executeTool('expandCombo', { session: statsSession }, { ...SEARCH_INPUT });
const on = await adapter.executeTool('expandCombo', { session: statsSession }, { ...SEARCH_INPUT, measureStates: true });
t.check('the unmeasured search succeeds', off.ok, true);
t.check('the measured search succeeds', on.ok, true);
if (!off.ok || !on.ok) {
  t.finish();
}
const offData = off.data;
const onData = on.data;
const stats = onData.statistics;

t.check('statistics are absent by default', 'statistics' in offData, false);
t.check('  and no route carries a terminal tag by default',
  offData.routes.some((route) => 'terminalKey' in route), false);
t.check('  and the runtime-internal name never reaches the response', 'stateStats' in onData, false);
t.assert('statistics are present when asked for', !!stats, JSON.stringify(Object.keys(onData)));

t.section('hook coverage: every node and every terminal is seen');
// The bug this pins: terminals had no hook, so the report said
// `terminalVisits: 0, terminalDuplicateRate: 0.0 %` — a zero that meant
// "unmeasured". `visits == nodes` is the other half: the terminal hook must not
// inflate the node count, and no node may be missed.
t.check('every visited node was counted', stats.nodes, offData.nodes);
t.check('the visit count is not inflated by terminal settlements',
  stats.nodes, onData.nodes);
t.assert('terminals are actually measured', stats.terminals.visits > 0,
  JSON.stringify(stats.terminals));
t.assert('  and the raw terminal count still counts every position it settled',
  stats.terminalCountRaw >= stats.terminals.distinct,
  `raw=${stats.terminalCountRaw} distinct=${stats.terminals.distinct}`);
// The ordering guarantee the search core now claims: the terminal hook fires only
// after the settlement has been counted, so every reported settlement was counted
// (`visits <= terminalCountRaw`) and a settlement that throws first is reported to
// nobody. Emitting before the counter left a window where the two disagreed.
t.assert('  every reported settlement was counted by the search itself',
  stats.terminals.visits <= stats.terminalCountRaw,
  `visits=${stats.terminals.visits} raw=${stats.terminalCountRaw}`);
const searchCoreSource = readFileSync(`${ROOT}/skill/runtime/src/core/search/exact-search.cjs`, 'utf8');
// A structural pin, because the mis-ordering is invisible in a healthy run: the
// counter must be incremented before the hook is emitted inside `settleTerminal`.
const settleStart = searchCoreSource.indexOf('const settleTerminal = (');
const settleSource = searchCoreSource.slice(settleStart, searchCoreSource.indexOf('const settleCurrentDecisionIfTerminal', settleStart));
t.check('the settlement counter is incremented before the hook is emitted',
  settleSource.indexOf('best.terminalCount += 1') < settleSource.indexOf('onStateVisit && terminalKey'), true);

t.section('the reported rates are self-consistent');
const strictRate = 1 - stats.distinctStates / stats.nodes;
const coarseRate = 1 - stats.coarseDistinctStates / stats.nodes;
t.check('duplicateRate is the strict rate',
  Math.abs(stats.duplicateRate - strictRate) < 0.001, true);
t.check('coarseDuplicateRate is the coarse rate',
  Math.abs(stats.coarseDuplicateRate - coarseRate) < 0.001, true);
t.check('the field alone can only merge states, never split them',
  stats.coarseDistinctStates <= stats.distinctStates, true);
t.check('  so the coarse rate is the higher one',
  stats.coarseDuplicateRate >= stats.duplicateRate, true);
t.check('a repeated state is counted', stats.repeatedStates > 0, true);
t.check('worstRepeat is at least one visit', stats.worstRepeat >= 1, true);
t.check('  and it is a real repeat, not a tautology', stats.worstRepeat > 1, true);
t.check('distinct terminal positions never exceed terminal visits',
  stats.terminals.distinct <= stats.terminals.visits, true);
t.check('  and never exceed the raw terminal count',
  stats.terminalCountDistinct <= stats.terminalCountRaw, true);
t.check('distinct terminal groups never exceed the routes',
  stats.topK.distinctTerminals <= stats.topK.routes, true);
t.check('the distinct terminal count is the group count',
  stats.terminalCountDistinct, stats.terminals.distinct);

t.section('duplication is reported, not asserted away');
t.check('the top-K really contains a repeated terminal',
  stats.topK.distinctTerminals < stats.topK.routes, true);
t.check('  the largest order-variant group is recorded',
  stats.topK.largestVariants > 1, true);
// Terminal positions are keyed by the visible field *including* battle position
// now, and at this budget every settlement landed on a distinct position — so the
// honest assertion is the direction, not a duplicate that this configuration does
// not have. (The repeats that are visible here are at the route level, above: two
// routes that end on one terminal through different orders.) The older
// `terminals.distinct < terminals.visits` claim belonged to the position-blind key
// and is deliberately not carried over as a fact about this one.
t.assert('  every settlement was keyed as a position, repeated or not',
  stats.terminals.visits > 0 && stats.terminals.distinct <= stats.terminals.visits,
  JSON.stringify(stats.terminals));
t.note(`nodes=${stats.nodes} strict=${stats.distinctStates} (${(stats.duplicateRate * 100).toFixed(1)} % dup) `
  + `coarse=${stats.coarseDistinctStates} (${(stats.coarseDuplicateRate * 100).toFixed(1)} % dup) `
  + `worstRepeat=${stats.worstRepeat} terminals=${stats.terminals.visits}/${stats.terminals.distinct} `
  + `(${(stats.terminals.duplicateRate * 100).toFixed(1)} % dup) routes=${stats.topK.routes} groups=${stats.topK.distinctTerminals}`);
t.check('  the note repeats the grouping',
  String(onData.note).endsWith(describeStateStatistics(stats)), true);
t.assert('  and the unmeasured note says nothing about terminals',
  !/distinct terminal/.test(String(offData.note)), String(offData.note));

t.section('variants are labelled, never merged away');
const routeKeys = onData.routes.map((route) => route.terminalKey);
t.check('every route carries a terminal key',
  routeKeys.every((key) => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)), true);
t.check('every route carries a terminal group',
  onData.routes.every((route) => Number.isInteger(route.terminalGroup) && route.terminalGroup >= 1), true);
t.check('routes in one group share one key',
  onData.routes.every((route) => routeKeys.filter((_, index) => onData.routes[index].terminalGroup === route.terminalGroup)
    .every((key) => key === route.terminalKey)), true);
t.check('different groups have different keys',
  new Set(onData.routes.map((route) => route.terminalGroup)).size, new Set(routeKeys).size);
t.check('  the group count is what the statistics report',
  new Set(routeKeys).size, stats.topK.distinctTerminals);
t.check('  the largest group is what the statistics report',
  Math.max(...onData.routes.map((route) => route.terminalVariants ?? 1)), stats.topK.largestVariants);
t.check('  and the label matches the group size',
  onData.routes.every((route) => route.terminalVariants === undefined
    || route.terminalVariants === routeKeys.filter((key) => key === route.terminalKey).length), true);
t.check('  all routes are kept', onData.routes.length, stats.topK.routes);

t.section('neutrality: the same seed returns byte-identical routes');
// Wall-clock fields (`routeFoundElapsedMs`, `searchElapsedMs`) and the random job
// handle legitimately differ between two runs, so this compares a projection of
// what a caller actually acts on rather than the whole object. The projection is
// `[rank, score, depth, labels]` plus the counts a caller uses to decide whether
// the search is finished.
const projection = (data) => ({
  openingCodes: data.openingCodes,
  openingRemainCount: data.openingRemainCount,
  nodes: data.nodes,
  terminalCount: data.terminalCount,
  stopReason: data.stopReason,
  completed: data.completed,
  routesConsidered: data.routesConsidered,
  routesCollapsedAsPlacementVariants: data.routesCollapsedAsPlacementVariants,
  routes: data.routes.map((route) => [
    route.rank,
    route.score,
    route.depth,
    route.terminalDepth,
    route.terminalReason,
    route.steps.map((step) => step.label),
  ]),
});
const offProjection = JSON.stringify(projection(offData));
const onProjection = JSON.stringify(projection(onData));
// Reported as a diff prefix rather than a giant JSON dump: if this ever breaks, the
// interesting fact is *where* the two runs first disagree.
const firstDifference = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return `at byte ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`;
  }
  return 'no difference';
};
t.assert('measureStates on and off return the same search result',
  offProjection === onProjection,
  firstDifference(offProjection, onProjection));
t.assert('  with the same route count', offData.routes.length === onData.routes.length,
  `${offData.routes.length} vs ${onData.routes.length}`);
t.check('  and the same node total', offData.nodes, onData.nodes);
t.check('  and the same terminal total', offData.terminalCount, onData.terminalCount);
t.check('the projection deliberately excludes the wall clock',
  /routeFoundElapsedMs/.test(JSON.stringify(projection(onData))), false);

t.section('a live expandCombo reply states its parallel decision');
t.assert('the reply carries the decision that was taken',
  onData.engine?.parallelism?.active === false, JSON.stringify(onData.engine));
t.check('  and that this entry point never asks for parallel',
  onData.engine?.parallelism?.requested, false);
t.check('  so there is no disabled request to explain',
  onData.engine?.parallelism?.disabledReason, null);
t.check('  with the serial backend named for what it is',
  onData.engine?.exactSearchBackend, 'js');
t.check('  and the worker count it actually used', onData.engine?.workers, 1);

t.section('analyzeReplay reports its own elapsed time');
// The reply carried no timing anywhere, so a caller could only time the round trip
// from outside. `elapsedMs` is the tool's own measurement of the call it just
// served, and it is added to the reply rather than to the parsed payload, so the
// shape a caller stored stays what it was.
const { createModelToolHost } = await import(`file:///${ROOT}/skill/backend/index.mjs`);
const analyzeHost = createModelToolHost({}, {});
// A real replay, shipped as a fixture of the vendored replay codec: `context` alone
// would not cover the parse path this field is here for.
const YRP_FIXTURE = `${ROOT}/skill/vendor/node_modules/ygopro-yrp-encode/ygopro-yrp-test-remake.yrp`;
const timedAnalyze = async (input) => {
  const measuredStartedAt = Date.now();
  const reply = await analyzeHost.execute({ name: 'analyzeReplay', sessionId: 'analyze-elapsed', input });
  return { measuredMs: Date.now() - measuredStartedAt, result: reply?.result ?? {} };
};
const contextCall = await timedAnalyze({ action: 'context' });
const parseCall = await timedAnalyze({ action: 'parse', file: YRP_FIXTURE });
const analyzeCall = await timedAnalyze({ action: 'analyze', file: YRP_FIXTURE });
t.check('the context action still succeeds', contextCall.result.ok, true);
t.check('the parse action still succeeds', parseCall.result.ok, true);
t.check('the analyze action still succeeds', analyzeCall.result.ok, true);
for (const [label, call] of [['context', contextCall], ['parse', parseCall], ['analyze', analyzeCall]]) {
  const elapsedMs = call.result.data?.elapsedMs;
  t.assert(`${label}: elapsedMs is a non-negative integer`,
    Number.isInteger(elapsedMs) && elapsedMs >= 0, String(elapsedMs));
  // Measured, not estimated: the tool cannot have taken longer than the call did.
  t.assert(`  ${label}: it does not exceed the call it measures`,
    elapsedMs <= call.measuredMs + 1, `${elapsedMs} ms reported vs ${call.measuredMs} ms measured`);
}
t.check('the nested parse result is not polluted with it',
  'elapsedMs' in (analyzeCall.result.data?.parsed ?? {}), false);
t.check('  nor is the nested context result',
  'elapsedMs' in (analyzeCall.result.data?.context ?? {}), false);
t.check('the parse payload still carries its own fields',
  Object.keys(parseCall.result.data ?? {}).includes('replay'), true);
// The field is only added where it did not exist: `expandCombo` already reports its
// search time under its own name.
t.check('expandCombo gains no elapsedMs', 'elapsedMs' in offData, false);
t.assert('  while still reporting searchElapsedMs',
  typeof offData.searchElapsedMs === 'number', String(offData.searchElapsedMs));

t.section('the same measurement is offered on the tools that had none');
// `manageEngineSession` is the one tool served entirely inside the host (no engine
// session involved), and `queryCards` is an ordinary action-table tool. Both used to
// answer with no timing at all.
const timedTool = async (name, input, sessionId) => {
  const measuredStartedAt = Date.now();
  const reply = await analyzeHost.execute({ name, sessionId, input });
  return { measuredMs: Date.now() - measuredStartedAt, result: reply?.result ?? {} };
};
const statusCall = await timedTool('manageEngineSession', { action: 'status' }, 'elapsed-status');
const queryCall = await timedTool('queryCards', { action: 'get', cardName: '青眼白龙' }, 'elapsed-query');
t.check('the engine-session status action still succeeds', statusCall.result.ok, true);
t.check('a regular card query still succeeds', queryCall.result.ok, true);
for (const [label, call] of [['manageEngineSession', statusCall], ['queryCards', queryCall]]) {
  const elapsedMs = call.result.data?.elapsedMs;
  t.assert(`${label}: elapsedMs is a non-negative integer`,
    Number.isInteger(elapsedMs) && elapsedMs >= 0, String(elapsedMs));
  // Measured, not estimated, and measured inside the host: it can never exceed the
  // caller's own round trip, which is strictly longer (transport + serialisation).
  t.assert(`  ${label}: it does not exceed the call it measures`,
    elapsedMs <= call.measuredMs + 1, `${elapsedMs} ms reported vs ${call.measuredMs} ms measured`);
}

t.finish();
