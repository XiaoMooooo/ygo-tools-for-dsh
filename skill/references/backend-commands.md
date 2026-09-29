# YGO Tool Guide

Use only the 16 YGO tools registered by the DeepSeek Harness plugin. Do not
invoke backend modules, HTTP endpoints, shell commands, or temporary scripts
during model decision work.

## Session Start

Call `manageEngineSession({action:"status"})` first. DeepSeek Harness binds the
current agent to one persistent engine session automatically; never create or
pass a session ID. Use `resetGame` for a new duel. Use `manageEngineSession`
actions `clear` or `shutdown` with `confirm:true` only for explicit teardown.
`status` reports `reachable`, `port`, `tokenPath`, `lastError`, and
`needsRestart`, and cold starts the host when it is unreachable. Action
`restart` (no `confirm`) stops the host and cold starts a fresh one; it drops
every live engine session, so use it only to recover an unreachable or wedged
host.

## Public Tools

- `queryCards`: `action:"get"` for one exact card; `action:"search"` for name,
  text, or type search.
- `manageCardDataSources`: `action:"inspect"` for local resource evidence;
  `action:"refresh"` with `allowNetworkUpdate:true` for an authorized update.
- `manageYgoPro2`: `action:"discover"` for installation readiness;
  `action:"status"` for the active real-duel bridge.
- `getBanlistContext`: parsed banlist evidence and optional card status.
- `manageSessionDeck`: actions `set`, `get`, `check`, `edit`, and `export`.
- `resetGame`: start an embedded or YGOPro2 duel. Use `fixedOpening` or
  `clearFixedOpening:true` to change the embedded opening atomically with reset.
- `observeDuel`: `action:"state"` for visible state or `action:"actions"` for
  current legal actions.
- `executeAction`: execute one legal action and return synchronized state and
  the next decision.
- `simulateActions`: compare a short embedded continuation without committing.
- `expandCombo`: search engine-verified combo routes for the loaded deck and get
  ranked action lines with scores, instead of stepping one action per call. Every
  call is bounded by a wall-clock slice (`timeSliceMs`, default 15000, capped at
  60000). A search that runs out of its slice stops cleanly and answers with
  `resumable:true` plus a `jobId` and `slice.{consumedMs,remainingMs}`; continue it
  with `expandCombo({jobId})` (the node count keeps growing) and drop it with
  `expandCombo({jobId,cancel:true})`. `stopReason:"TIME_SLICE"` with
  `completed:false` and `ordersTruncated:true` means the routes are partial, not
  exhausted. Never send a resume state: it stays on the engine host.
  A continuation keeps the opening its job was created for: the job's own `seed`,
  `openingCodes` and `drawCount` are reused and echoed back unchanged
  (`drawInputsSource:"job"`), so the same hand stays under search and
  `slice.nodesAtSliceStart` chains from the previous `nodesSoFar`. Passing a
  conflicting `seed`/`openingCodes`/`drawCount` together with a `jobId` is ignored,
  not obeyed: the call reports the job values it used in `ignoredDrawInputs` (and in
  `note`) instead of silently searching a different opening.
  `slice.nodesThisSlice` is the work this slice newly extended; `slice.revisitedNodes`
  is the work it re-executed to rebuild positions the chain had already reached (a
  frame restore that had to replay history rather than take a snapshot). Read them
  together: `nodesThisSlice` alone cannot tell "continued" from "repeated". A `0` in
  `revisitedNodes` means no restore had to replay — it can also mean the runner
  does not report the counter, so treat it as a lower bound, never as "the search
  proved there was no re-walk".
  A chain may be continued `YGO_COMBO_MAX_CONTINUATIONS` times (default 32, capped
  at 512 by the env override). Each reply reports how far along the chain it is
  (`continuations`, `continuationLimit`). Past the limit the call fails with
  `COMBO_CONTINUATION_LIMIT` **before any search runs**, and the job is dropped so
  the refusal cannot be retried: start a fresh `expandCombo` call if more searching
  is genuinely wanted. This is a runaway-loop guard, not a cost fix — it bounds one
  chain, which the job-store cap (`YGO_COMBO_JOB_CAP`) does not.
  This entry point is always the single-process serial exact backend
  (`engine.exactSearchBackend:"js"`, one worker); the parallel-exact backend is only
  reachable from the command-line search, and it is refused outright when
  `targetTerminals` is set. Either way the decision is reported, never silent:
  `engine.parallelism` carries `{requested, active, disabledReason}`, and the
  command-line search prints the same reason (`disabledReason:"target-terminals"`)
  when it falls back to one serial process.
  `measureStates:true` (default off) adds statistics and changes nothing else: the
  routes are byte-identical with it on or off. The `statistics` block reports
  `nodes`, `distinctStates`/`duplicateRate` (strict key: the field *plus* the
  current legal action set), `coarseDistinctStates`/`coarseDuplicateRate` (coarse
  key: the field alone, ignoring the action set and deck order — the gap between the
  two rates is the duplication that only shows up once the options already differ),
  `worstRepeat`, `terminals {visits, distinct, duplicateRate}`,
  `topK {routes, distinctTerminals, largestVariants}`, and `terminalCountRaw` vs
  `terminalCountDistinct` (how inflated the raw terminal count is). Both keys
  include battle position and face-up/face-down for the monster and spell/trap
  zones, taken from the per-zone card detail the runner already exposes, so a
  face-down set monster and the same monster face-up are different positions. Each
  route also carries `terminalKey`/`terminalGroup` (and `terminalVariants` when
  repeated): routes that end on the same terminal through a different action order
  are kept and labelled as one group, never merged.
  Every counted terminal settlement is reported exactly once
  (`terminals.visits <= terminalCountRaw`): the visit hook fires only after the
  settlement has been counted, so a settlement that throws first is reported to
  nobody rather than inflating one side of the pair.
- `planRoute`: order declared steps by their dependencies and get the valid
  orderings, or an explanation of the cycle, the missing requirement, or the
  unreachable goal that prevents ordering. Purely declarative: no engine runs.
- `manageCheckpoint`: actions `save`, `restore`, `list`, and `delete`.
- `analyzeReplay`: actions `parse`, `context`, and `analyze`; `analyze` parses
  and builds model-readable context in one call. Every reply carries `elapsedMs`,
  the integer wall clock the engine host measured for that call.
- `analyzeCombo`: `action:"parse"` normalizes an artifact; `action:"adapt"`
  compares it with the loaded deck.
- `saveArtifact`: `action:"replay"` or `action:"route"`; use only for an
  explicitly requested file.
- `manageEngineSession`: actions `status`, `restart`, `clear`, and `shutdown`.

## Reply Timing

Every tool reply except `expandCombo` carries `elapsedMs`: the integer wall clock the
engine host spent handling that one call, measured from the start of tool dispatch
(so a first call that also creates the session and cold starts the engine reports
what it really cost) to the moment the reply was built.

It deliberately **excludes the HTTP transport** between the DSH plugin and the engine
host, and therefore the request/response transfer and its JSON serialisation: the
caller's own round trip is always a little longer than this number. It is measured,
never estimated. Two caveats worth knowing:

- `expandCombo` has no `elapsedMs` on purpose: its `searchElapsedMs` and
  `slice.consumedMs` already report the search it exists for, and a second,
  differently-windowed number in the same reply would only invite the two to be
  compared as if they measured one thing.
- `manageEngineSession` reports it too, but a `restart` finishes in the client
  *after* the host replies, so that action's total time is not this number.

## Discipline And Evidence

Pass unchanged YDK text to `manageSessionDeck({action:"set",ydk})`. Large
ordered selections are factorized and paged; use returned selection indexes.
A successful `executeAction` already returns synchronized `state` and
`nextDecision`, so observe again only after missing output, failure,
interruption, or no progress.

Start a real duel only with an explicit YGOPro2 backend, opponent profile, and
turn order. Discovery is not a live connection. Require
`manageYgoPro2({action:"status"})` evidence with `liveDuelBridge:true`; never
silently fall back to the embedded runner.

Real duels cannot use fixed openings, simulation, checkpoints, or rollback. To
end and export a running real duel, use
`saveArtifact({action:"replay",surrenderIfRunning:true,...})` only at the user's
request. A saved file is not proof that a combo completed or won.

Card claims require `queryCards`; deck claims require `manageSessionDeck` or
current-deck card evidence; state and legality claims require current duel tool
output; replay claims are limited to `analyzeReplay` output.

## Tooling Discipline

- `analyzeReplay` parses `.yrp`, `.yrp2` and `.yrp3d` **offline**: it starts its own
  embedded engine and needs neither a live YGOPro2 bridge nor a duel runner. Never
  parse a replay by hand, and never copy the skill or build your own harness.
- `expandCombo` runs the engine's own search inside the engine host. Use it instead
  of writing a search script. If a tool cannot do what is needed, report the
  limitation rather than working around it.
- **Negative observations only count when they come from these tools.** "The engine
  does not offer this action" is evidence only from a normal session. A hand-built
  harness auto-answers prompts and manipulates state, so its negatives are false
  negatives — never turn one into a rule.
- Rules that hang on wording — cost versus effect, optional 「才能发动」 versus a
  mandatory trigger, 「時」 versus 「場合」 — must be settled from the card text and
  the tool output, never inferred from a summary of them.
