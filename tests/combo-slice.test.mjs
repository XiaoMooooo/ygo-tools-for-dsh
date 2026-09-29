// `expandCombo` wall-clock slicing: a bounded, resumable search.
//
// P1 regression suite. Before this, `expandCombo` ran the whole search
// synchronously inside the engine host process: a `maxNodes: 6000` call ran for
// minutes, blocked every other tool call, and killed the host — which took all 16
// YGO tools away from the session. These checks pin the three properties that
// make that failure impossible:
//
//   1. a call stops at the slice boundary and hands back a small continuation
//      handle instead of throwing its work away;
//   2. continuing from that handle adds nodes rather than re-walking the root;
//   3. the resume state (the serialized DFS stack, hundreds of KB) stays on the
//      host and never enters the model payload, and the host's job store is
//      bounded.
//
// The host is spawned with stdio 'ignore': this suite must also run where the
// harness forbids capturing a child's piped stdio.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { reporter, ROOT } from './harness.mjs';

const t = reporter();
const SERVER = `${ROOT}/skill/backend/persistent-engine-server.mjs`;
const PORT = Number(process.env.YGO_COMBO_TEST_PORT ?? 19983);
const TOKEN = 'test-token-combo-slice-0123';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = join(ROOT, 'tests', '.sandbox', 'combo-slice');
// The bundled deck is the engine's own resource deck, so the search has a real
// opening hand to expand from.
const YDK = readFileSync(`${ROOT}/skill/resources/lib/slm.ydk`, 'utf8');
// A short slice keeps this suite fast; the real default is 15000 ms and only the
// boundary behaviour is under test here.
const SHORT_SLICE_MS = 1200;
// The job store's cap is configurable exactly so it can be exercised without
// starting nine real searches. One retained job holds a serialized DFS stack, so
// an unbounded store is the failure this bound exists to prevent.
const JOB_CAP = 3;

rmSync(DATA, { recursive: true, force: true });

const child = spawn(process.execPath, [SERVER, '--host', '127.0.0.1', '--port', String(PORT)], {
  // YGO_COMBO_JOB_CAP is set on this host, and the client below never starts one
  // of its own, so the cap under test is unambiguously the one this process has.
  // YGO_CACHE_DIR keeps the shared token file inside the sandbox directory this
  // suite cleans up.
  env: {
    ...process.env,
    YGO_ENGINE_TOKEN: TOKEN,
    YGO_COMBO_JOB_CAP: String(JOB_CAP),
    YGO_CACHE_DIR: join(DATA, 'cache'),
  },
  stdio: 'ignore',
  windowsHide: true,
});

let ok = false;
try {
  const { createPersistentEngineClient } = await import(`file:///${ROOT}/skill/backend/persistent-engine-client.mjs`);
  const client = createPersistentEngineClient({
    hostname: '127.0.0.1',
    port: PORT,
    // The host is started above, so the client must never start a second one on
    // the same port: that would silently test a host with a different job cap.
    autoStart: false,
    token: TOKEN,
  });
  const session = { sessionId: 'dsh-combo-slice' };
  const call = async (name, input) => client.execute({ name, input }, session);

  t.section('the sliced search host starts');
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) { ok = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  t.assert('an expandCombo host answers /health', ok, `no response on ${BASE}`);
  if (!ok) {
    child.kill();
    t.finish();
  }

  // A deck is required by expandCombo; the bundled ydk text is enough, so no
  // separate manageSessionDeck round trip is needed.
  const search = (input) => call('expandCombo', { ydk: YDK, seed: 4242, maxDepth: 40, ...input });

  t.section('a slice that runs out stops cleanly and stays resumable');
  const first = await search({ maxNodes: 100000, timeSliceMs: SHORT_SLICE_MS });
  const firstData = first.result?.data ?? {};
  t.check('the sliced call succeeds', first.ok, true);
  t.check('  and reports it ran out of its slice', firstData.stopReason, 'TIME_SLICE');
  t.check('  which is not a completed search', firstData.completed, false);
  t.check('  and is reported as truncated to the model', firstData.ordersTruncated, true);
  t.assert('  with a resumable=true handle', firstData.resumable === true, JSON.stringify(firstData).slice(0, 400));
  t.assert('  carrying a job id', typeof firstData.jobId === 'string' && firstData.jobId.length > 0,
    String(firstData.jobId));
  t.assert('  and the node count it reached', Number(firstData.nodesSoFar) > 0, String(firstData.nodesSoFar));
  t.check('  the slice boundary is attributed to the clock', firstData.slice?.endedByTimeSlice, true);
  t.check('  and the resolved budget is reported', firstData.slice?.timeSliceMs, SHORT_SLICE_MS);
  t.assert('  with the consumed time reported', Number(firstData.slice?.consumedMs) > 0,
    JSON.stringify(firstData.slice));
  t.assert('  consuming no more than the budget plus a small overshoot',
    Number(firstData.slice?.consumedMs) <= SHORT_SLICE_MS * 1.5,
    `consumed=${firstData.slice?.consumedMs} budget=${SHORT_SLICE_MS}`);

  t.section('the resume state stays on the host');
  const firstPayload = JSON.stringify(first);
  // The host keeps the engine's raw resume payload (root state plus every pending
  // DFS frame). Measured on this deck it is ~250 KB after one slice and grows; it
  // must never appear in what the model receives.
  t.assert('the model payload stays under 100 KB', firstPayload.length < 100 * 1024,
    `${firstPayload.length} bytes`);
  t.assert('  and carries no resumeState', !/resumeState/i.test(firstPayload),
    firstPayload.slice(0, 200));
  t.assert('  and no serialized DFS stack', !/"stack"\s*:/.test(firstPayload),
    firstPayload.slice(0, 200));
  const retainedAfterFirst = Number(firstData.retainedJobCount);
  t.assert('  one job is retained on the host', retainedAfterFirst >= 1, String(retainedAfterFirst));

  t.section('continuing a job adds nodes instead of repeating the root');
  const second = await search({ maxNodes: 100000, timeSliceMs: SHORT_SLICE_MS, jobId: firstData.jobId });
  const secondData = second.result?.data ?? {};
  t.check('the continued call succeeds', second.ok, true);
  t.assert('the cumulative node count grew',
    Number(secondData.nodesSoFar) > Number(firstData.nodesSoFar),
    `${firstData.nodesSoFar} -> ${secondData.nodesSoFar}`);
  t.assert('  because it started from where the first slice stopped',
    Number(secondData.slice?.nodesAtSliceStart) === Number(firstData.nodesSoFar),
    `start=${secondData.slice?.nodesAtSliceStart} first=${firstData.nodesSoFar}`);
  t.assert('  so this slice paid for nodes of its own',
    Number(secondData.slice?.nodesThisSlice) > 0, String(secondData.slice?.nodesThisSlice));
  t.check('  and it reports the job it continued from', secondData.continuedFromJobId, firstData.jobId);
  t.check('  the continuation is resumable again', secondData.resumable, true);
  t.assert('  with a fresh job id', secondData.jobId !== firstData.jobId, String(secondData.jobId));

  t.section('a completed search retains no job');
  // A shallow depth cap empties the DFS frontier well inside the slice, so the
  // search reports DONE rather than a budget boundary.
  const shallow = await search({ maxNodes: 100000, maxDepth: 2, timeSliceMs: 20000 });
  const shallowData = shallow.result?.data ?? {};
  t.check('a search that finishes in its slice succeeds', shallow.ok, true);
  t.check('  reports the search as complete', shallowData.completed, true);
  t.check('  with stopReason DONE', shallowData.stopReason, 'DONE');
  t.check('  and ordersTruncated false', shallowData.ordersTruncated, false);
  t.check('  resumable is false', shallowData.resumable, false);
  t.check('  no job id is returned', shallowData.jobId, null);
  t.assert('  the engine returned no resume state for it',
    !/resumeState/i.test(JSON.stringify(shallow)), JSON.stringify(shallow).slice(0, 200));

  t.section('a completed search frees the job it continued from');
  const resumedJobs = await search({ maxNodes: 100000, timeSliceMs: SHORT_SLICE_MS, jobId: secondData.jobId });
  const resumedJobsData = resumedJobs.result?.data ?? {};
  t.check('continuing still works', resumedJobs.ok, true);
  const retainAfterContinue = Number(resumedJobsData.retainedJobCount);
  t.assert('continuing consumes the exhausted job rather than keeping it',
    retainAfterContinue <= 1, `retained=${retainAfterContinue}`);

  t.section('the job store is bounded by YGO_COMBO_JOB_CAP');
  // This is the failure mode the bound exists for: one retained job holds a
  // serialized DFS stack of hundreds of KB, so an unbounded store would grow with
  // the host's uptime. This host runs with YGO_COMBO_JOB_CAP=3, so the fifth job
  // must evict the first and none of them may throw.
  const cappedJobs = [];
  let capSeen = 0;
  for (let i = 0; i < 5; i += 1) {
    const started = await search({ maxNodes: 100000, timeSliceMs: SHORT_SLICE_MS, seed: 2000 + i });
    const data = started.result?.data ?? {};
    if (typeof data.jobId === 'string') cappedJobs.push(data.jobId);
    t.check(`  capped slice ${i + 1} succeeds`, started.ok, true);
    t.assert(`  retained stays <= 3 after ${i + 1} jobs`, Number(data.retainedJobCount) <= 3,
      `retained=${data.retainedJobCount}`);
    capSeen = Math.max(capSeen, Number(data.retainedJobCount) || 0);
  }
  t.assert('the store held jobs to evict', cappedJobs.length >= 4, JSON.stringify(cappedJobs));
  t.check('  and never exceeded its cap', capSeen, 3);
  const evicted = await search({ maxNodes: 100000, timeSliceMs: SHORT_SLICE_MS, jobId: cappedJobs[0] });
  t.check('  the oldest job was the one evicted', evicted.ok, false);
  t.check('  with the code that names it missing', evicted.result?.code, 'COMBO_JOB_NOT_FOUND');
  // A job that is still inside the cap keeps working: eviction must drop the
  // oldest, not reset the store.
  const survivor = cappedJobs[cappedJobs.length - 1];
  const survivorCall = await search({ maxNodes: 20000, timeSliceMs: SHORT_SLICE_MS, jobId: survivor });
  t.check('  the newest job still continues', survivorCall.ok, true);
  t.assert('  and resumes rather than restarting',
    Number(survivorCall.result?.data?.slice?.nodesAtSliceStart) > 0,
    JSON.stringify(survivorCall.result?.data?.slice));
  const cancelled = await search({ jobId: survivorCall.result?.data?.jobId, cancel: true });
  t.check('cancel succeeds', cancelled.ok, true);
  t.check('  and reports the job it dropped', cancelled.result?.data?.droppedJob, survivorCall.result?.data?.jobId);
  const afterCancel = await search({ maxNodes: 100000, timeSliceMs: SHORT_SLICE_MS, jobId: survivorCall.result?.data?.jobId });
  t.check('  a cancelled job cannot be continued', afterCancel.result?.code, 'COMBO_JOB_NOT_FOUND');
  const cancelUnknown = await search({ jobId: 'not-a-job-id', cancel: true });
  t.check('cancelling an unknown job is not an error', cancelUnknown.ok, true);
  t.check('  and nothing is reported as dropped', cancelUnknown.result?.data?.cancelled, false);

  t.section('mid-slice calls receive too much of the wrong thing');
  const badResume = await search({
    maxNodes: 100000,
    timeSliceMs: SHORT_SLICE_MS,
    resumeState: { resumeVersion: 1, stack: [] },
  });
  t.check('a model-supplied resumeState is refused', badResume.ok, false);
  t.check('  with a code that says why', badResume.result?.code, 'RESUME_STATE_IS_HOST_PRIVATE');

  t.section('the slice budget is bounded and its default does not blame the clock');
  // A node-budget stop must keep its own vocabulary: the slice fields may not turn
  // every incomplete search into a time-slice story.
  const nodeBudgetStop = await search({ maxNodes: 500, timeSliceMs: 20000 });
  const nodeBudgetData = nodeBudgetStop.result?.data ?? {};
  t.check('a node-budget stop reports MAX_NODES', nodeBudgetData.stopReason, 'MAX_NODES');
  t.check('  and is not attributed to the clock', nodeBudgetData.slice?.endedByTimeSlice, false);
  t.check('  and is still resumable', nodeBudgetData.resumable, true);
  t.check('  with the time budget left over', nodeBudgetData.slice?.timeSliceMs, 20000);
  t.assert('  and its note does not claim a slice ran out',
    /budget boundary/.test(String(nodeBudgetData.note)), String(nodeBudgetData.note));
  await search({ jobId: nodeBudgetData.jobId, cancel: true });
  // Asserting the ceiling over HTTP would mean waiting a full minute of search, so
  // the resolved-budget rules are checked directly instead.
  const { DEFAULT_COMBO_TIME_SLICE_MS, MAX_COMBO_TIME_SLICE_MS, resolveComboTimeSliceMs } =
    await import(`file:///${ROOT}/skill/backend/source-adapter.mjs`);
  t.check('the default slice is 15 s', DEFAULT_COMBO_TIME_SLICE_MS, 15000);
  t.check('the ceiling is 60 s', MAX_COMBO_TIME_SLICE_MS, 60000);
  t.check('an absent slice takes the default', resolveComboTimeSliceMs(undefined), DEFAULT_COMBO_TIME_SLICE_MS);
  t.check('a zero slice takes the default', resolveComboTimeSliceMs(0), DEFAULT_COMBO_TIME_SLICE_MS);
  t.check('a negative slice takes the default', resolveComboTimeSliceMs(-5), DEFAULT_COMBO_TIME_SLICE_MS);
  t.check('an absurd slice is clamped to the ceiling', resolveComboTimeSliceMs(999999), MAX_COMBO_TIME_SLICE_MS);
  t.check('a slice inside the range is honored', resolveComboTimeSliceMs(4200), 4200);

  t.section('host responsiveness: a cheap tool call while a long job exists');
  // Fire a sliced search and, without awaiting it, run queryCards while the search
  // is still inside its slice. If the slice blocked the event loop end to end, the
  // host could not read another request off the socket until the search was done,
  // so the cheap answer could only arrive after the whole search had finished.
  const longSliceMs = 4000;
  const searchStartedAt = Date.now();
  const longSearch = search({ maxNodes: 200000, timeSliceMs: longSliceMs });
  // Give the search a moment to actually enter its loop before probing, so the
  // probe genuinely lands mid-slice rather than before the call is dispatched.
  await new Promise((r) => setTimeout(r, 400));
  const probe = await call('queryCards', { action: 'get', cardName: '青眼白龙' });
  const probeFinishedAt = Date.now();
  t.check('a cheap tool call succeeds while a long job exists', probe.ok, true);
  const longResult = await longSearch;
  const longData = longResult.result?.data ?? {};
  const searchFinishedAt = Date.now();
  const searchMs = searchFinishedAt - searchStartedAt;
  const probeOffsetMs = probeFinishedAt - searchStartedAt;
  t.note(`search=${searchMs} ms (slice ${longSliceMs} ms), cheap call answered ${probeOffsetMs} ms in`);
  // Strictly inside the search's lifetime, which is only possible if the event loop
  // was served while the search was still walking. Without the cooperative yield
  // the probe would come back at roughly the search's own finish time.
  t.assert('  the cheap call answered before the long search finished',
    probeFinishedAt < searchFinishedAt, `probe=${probeOffsetMs} search=${searchMs}`);
  t.assert('  and it did not wait for the slice to end',
    probeOffsetMs < longSliceMs, `probe=${probeOffsetMs} slice=${longSliceMs}`);
  t.assert('  the long search still produced a resumable handle',
    longData.resumable === true && typeof longData.jobId === 'string',
    JSON.stringify(longData).slice(0, 300));
  t.check('  and it still consumed its whole slice', longData.slice?.endedByTimeSlice, true);
  await search({ jobId: longData.jobId, cancel: true });
} finally {
  child.kill();
  rmSync(DATA, { recursive: true, force: true });
}

t.finish();
