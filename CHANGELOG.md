# Changelog

## 1.2.4 — 2026-09-30

- **修复 `expandCombo` 续跑会重新掷起手与 seed**。续跑此前只带回 `resumeState`，`seed` 与 `openingCodes` 每次都在调用侧重新推导：续跑实际搜的是**另一副起手**（实测首片固定手牌 `[14558128,81171949,12266229,31425736,42141493]`，续跑变成 `[70278545,31425736,48452496,97268402,73642296]`），搜出来的路线却挂在一个为别的起手创建的 job 上；省略 `seed` 时每续一次就重掷一次（`4242 → 3989834060 → …`），只有节点计数是对的。现在 job 连同 `seed` / `openingCodes` / `drawCount` 一起保存，续跑原样取回并回显（新增 `drawInputsSource:"job"`），因此每一片搜的都是同一个起手，`slice.nodesAtSliceStart` 依旧承接上一片的 `nodesSoFar`，`continuedFromJobId` 不变。
  - **冲突策略：忽略并报告，不静默照办，也不报错**。与 `jobId` 同时给出的 `seed` / `openingCodes` / `drawCount` 若与 job 不一致，调用照常成功，但在 `ignoredDrawInputs`（以及 `note`）里写清「你给了什么、实际用了 job 的什么」。选忽略而非拒绝的理由：续跑本来就只需要 `jobId`，模型复述参数是常见习惯，为一个冗余参数把可用的续跑直接拒掉代价大于收益；而**报告出来**就消除了真正的隐患——「以为自己的 seed 生效了」。空 `openingCodes` 视为「让引擎自己抽」，不算冲突。策略已写入工具描述、`jobId` 属性说明与 `skill/references/backend-commands.md`。
- **`analyzeReplay` 回复新增 `elapsedMs`，并说明它到底测的是哪一段**：`parse` / `analyze`（含 `context`）返回该次调用自身的墙钟毫秒（整数），由引擎主机自己测量，不是估算。**口径**：从工具分派开始（首次调用含会话创建与引擎冷启动）到回复对象构造完成；**不含**插件与引擎主机之间的 HTTP 传输及其 JSON 序列化，所以调用方自己的往返总是更长一点。字段加在 `data` 上，`analyze` 内嵌的 `parsed` / `context` 与被 `rememberParsedReplay` 记下的数据形状不变。
  - 同一测量现在也覆盖**除 `expandCombo` 以外的所有工具**（补在 `HOST_CONTROL` 分支与 `PUBLIC_TOOL_ACTIONS` 分派处，各一处）：`manageEngineSession`（含原本毫无计时的 `status`）、`queryCards`、`manageSessionDeck`、`observeDuel`、`executeAction`、`simulateActions`、`planRoute`、`manageCheckpoint`、`analyzeCombo`、`saveArtifact`、`getBanlistContext`、`manageCardDataSources`、`manageYgoPro2`。`expandCombo` **故意不加**：它的 `searchElapsedMs` / `slice.consumedMs` 已经报了它存在的意义，同一个回复里放两个窗口不同的数字只会被当成一回事比较。`manageEngineSession` 的 `restart` 例外：它在本回复之后才由客户端完成，因此该 action 的总耗时不是这个数。语义写入工具描述与 `skill/references/backend-commands.md` 的新 **Reply Timing** 小节，并有测试覆盖（含「不许超过调用方实测往返」与「`expandCombo` 不许出现该字段」）。
- 测试：`combo-slice` 72 → 120，`state-stats`（本周期新增的套件）114 项。新增断言中「续跑回显同一 `seed` / 同一 `openingCodes` / 引擎按固定手牌重建」三条是锁死本缺陷的断言，冲突策略四条锁死所选策略；实测把续跑改回重新推导后，这 7 条（以及旧代码下真的拿冲突 `openingCodes` 建起手导致的 `SEARCH_FAILED`）全部失败。
- **新增状态重复度统计（只测量，不剪枝）**。组合搜索反复走到同一个局面：**旧口径**（环检测那把键，见下一条）曾测得约 40% 的节点预算花在已经见过的局面上，最坏一个局面进了 12 次——那两个数字只属于那一代键，**与现在的重复率不可直接比较**，新口径的数字见下。现在 `expandCombo({measureStates:true})` 会额外返回 `statistics` 块，把「到底浪费了多少」量出来，并且**不改变任何搜索判定**——不剪枝、不重排、不改 top-K 选择、不碰路径级环检测，同一 seed 下 `measureStates` 开与关返回逐字节一致的路由。
  - `statistics` 字段：`nodes`（本次调用消费的节点数）、`distinctStates` / `duplicateRate`（**严格键**：可见场面 **+ 当前合法动作集**）、`coarseDistinctStates` / `coarseDuplicateRate`（**宽松键**：只看场面，忽略动作集与卡组顺序）、`worstRepeat`、`terminals { visits, distinct, duplicateRate }`、`topK { routes, distinctTerminals, largestVariants }`，以及 `terminalCountRaw` 与 `terminalCountDistinct`（暴露原始终局计数被同一局面重复结算膨胀了多少）。两个重复率的差值本身就是信号：它量化了「场面相同，但可用选项已经不同」的那部分重复。
  - **修掉一个静默的测量缺陷**：`onStateVisit` 此前只在两个 `best.nodes += 1` 处被调用，终局结算路径 `settleTerminal(...)` 完全没有 hook，于是报告里的 `terminalVisits: 0` / `terminalDuplicateRate: 0.0%` 是「没测」而不是「没有重复」。现在终局结算也走同一个 hook（`kind:"terminal"`，键在结算入口取、hook 在计数后发，见下一条），键是**局面键**而不是动作集键；终局计数因此不再虚高到无法解释。
  - **终局计数的顺序保证**：hook 此前在 `settleTerminal` 入口就发，而 `best.terminalCount += 1` 在其后，于是「结算抛异常」会让两边各说各话（被观测到的结算数可能多于搜索自己数到的数）。现在键仍在入口取（那时局面还没被动过），但 hook **只在计数完成之后**才发，保证 `terminals.visits <= terminalCountRaw`：抛在计数之前的结算对两边都不存在。不变量既在真实搜索上断言，也在源码顺序上钉死（`best.terminalCount += 1` 必须出现在 hook 之前），原有的 `terminalCountRaw >= terminalCountDistinct` 断言未削弱。
  - 新增纯模块 `skill/runtime/src/core/search/state-keys.cjs`：`conservativeStateKey(...)` / `coarseStateKey(...)`，无引擎依赖、确定性、码点排序（不用 `localeCompare`），键为 sha256 摘要以便当作 `Map` 键。
  - **修掉「键不区分表侧/里侧与表示形式」**：此前两个键都只投影每区的卡号，于是一只里侧守备表示的怪兽与同一只表侧攻击表示的怪兽哈希在一起。runner 其实**已经**给出这个信息——`captureSnapshot()` 的 `p0Zones` / `p1Zones` 里每张场地卡都带引擎的 `position` 标志字（`POS_FACEUP_ATTACK`/`POS_FACEDOWN_DEFENSE` 等，一个字段同时编码表示形式与表侧里侧）——所以现在**两个键都投影它**，只在怪兽区与魔法陷阱区（手牌/卡组/墓地/除外/额外没有朝向）。数据缺失时降级而不是猜：没有 zone 明细、或明细长度与卡号列表对不上（native runner 会强制清空 `szone`）时该区退回只看卡号；因此**不含明细的键不会等于含明细的键**，源码 doc 与 `skill/references/backend-commands.md` 都写明这一点。新增 10 项键单测（表侧/里侧、表示形式、标志字原文、无明细降级、无朝向的区不加朝向）。
  - **注意：键换过两次口径，所以 headline 数字只归各自那一代，彼此不可比**。① 最早节点 hook 用的是环检测那把键（场面＋动作集＋决策的 message 类别／reason／原始 response 字节），那一代读到「约 40% 的节点预算花在已见过的局面、最坏一个局面进 12 次」，同一 seed／预算（seed 4242、120 节点、`slm.ydk`）下 `duplicateRate 0.4583`；② 换成 `state-keys` 的严格键（场面＋动作集、**不含**表示形式）后，同一设置读到 `duplicateRate 0.675`、`coarseDuplicateRate 0.8833`、`worstRepeat 14`；③ 现在键里再纳入表侧/里侧与表示形式，重复率随之下降。**当前口径**（`slm.ydk`、seed 4242、`maxNodes 120`、`maxDepth 40`、引擎自己抽起手）：`nodes=120`、`duplicateRate 0.55`、`coarseDuplicateRate 0.8083`、`worstRepeat 11`、`terminals 13/13`；同一预算换 5 个 seed（4242/1/7/99/2024）实测 `duplicateRate 0.425–0.583`、`coarseDuplicateRate 0.758–0.85`、`worstRepeat 9–12`。此前公布过的任何数字（`0.4583`、`0.675`、`0.8833`、最坏 `12` 或 `14`）**都不能与这一组直接比较**。数字变小不是搜索变好，而是键不再把「消息类别／response 字节」算作局面差异、并且不再把里侧与表侧算作同一个局面。
  - 路由新增 `terminalKey` / `terminalGroup`（有重复时还有 `terminalVariants`）：**同一条终局的不同动作顺序会被保留并标注成一组**，绝不合并掉——复用 `collapsePlacementVariants` 已经建立的「变体」口径，`equivalentPlacementVariants`（同一条线、摆放不同）与 `terminalVariants`（同一终局、顺序不同）是同一件事的两个轴。这些标签只在 `measureStates:true` 时出现，普通调用负载一字未变。
  - `expandCombo` 的输入新增 `measureStates`（默认 `false`，`additionalProperties:false` 风格不变），公开工具数仍是 16 个，没有新增工具。`note` 会同时带上切片提示与一句人话，例如 `4 routes land on 3 distinct terminals; the largest group has 2 that differ only in order.`
  - 新增 `tests/state-stats.test.mjs`（114 项）：键单元测试（摆放噪声忽略、卡组顺序不影响宽松键、动作集不同则严格键不同、**表侧/里侧与表示形式进入两个键**、明细缺失时降级为只看卡号）、hook 覆盖（`nodes == 搜索节点数` 且 `terminalVisits > 0`，专门盯住「0 = 没测」这个 bug；另有 `terminals.visits <= terminalCountRaw` 与源码顺序断言）、**中立性**（同 seed、`measureStates` 开关两侧 `[rank, score, depth, labels]` 投影逐字节一致）、字段自洽（`duplicateRate ≈ 1 - distinctStates/nodes`、`distinctTerminals <= terminalVisits`、`worstRepeat >= 1`、`distinctTerminals <= routes`），一个固定起手且 `topK.distinctTerminals < routes` 的真实搜索用例（确保重复真的被报出来，而不是同义反复），以及 `elapsedMs` 的覆盖面与 `parallelism` 决策描述符的单元测试。
- **续跑代价可见，且单条续跑链有上限**。① 每次 `expandCombo` 回复的 `slice` 现在同时给 `nodesThisSlice`（本次新扩展的节点）与 `revisitedNodes`（本次为重建「链上已经到过的局面」而**重新执行**的引擎步数：帧还原时走了历史重放而不是快照）。计数器由 runner 提供——只有它知道一次还原是命中快照池（不重放、记 0）还是真的重放历史——所以**0 既可能是「没有重放」，也可能是「runner 没有上报」**，源码与文档都按这个保守语义写明，不假装 0 就是证据。实测（`slm.ydk`、seed 4242、`maxNodes 100000`：首片按请求的 1500 ms 停止，随后续跑 4 次、每次沿用默认 15000 ms 切片）重放步数为 `0 / 8 / 44 / 16 / 28`，同一批切片新扩展节点为 `169 / 1553 / 1558 / 1511 / 1887`：**在这套配置下重放在片内工作量里占比很小，续跑片的边际收益基本持平、没有衰减**。此前那串「167 → 540 → 1063 → 1288 → 2231 → 2348」出自另一套设置（6 × 1.5 s、另一个节点预算），不作为已成立的结论引用。
  - ② **续跑次数上限**（`YGO_COMBO_MAX_CONTINUATIONS`，默认 32、上限 512）：这是**独立成立的跑飞护栏**，不是上面那个代价问题的修复——job 存储的容量上限只限制同时存在几条链，不限制一条链跑多久，所以循环调用 `expandCombo({jobId})` 原本可以无限占用搜索预算。每条回复给出 `continuations`（含本次）与 `continuationLimit`；超限时**在跑任何搜索之前**返回 `COMBO_CONTINUATION_LIMIT` 并**丢弃该 job**（不能重试同一个拒绝），要更多就重新起一次搜索。默认 32 在 15 s 默认切片下约 8 分钟，正常多片搜索不会碰到；上限规则与拒绝路径都有测试（测试主机用 `YGO_COMBO_MAX_CONTINUATIONS=2` 覆盖）。
- **并行搜索不再被静默禁用**。`exact-parallel-runtime` 里 `targetTerminals > 0` 会让分片并行直接失效，而调用方只会看到一个「一样的」串行结果。现在决策本身是一个描述符：`describeParallelExactSearch(job)` 返回 `{ requested, active, disabledReason, workers }`，`shouldUseParallelExactSearch` 就是它的 `active`（单一事实来源，因此上报的原因不可能与实际决策不一致）：`target-terminals`（`targetTerminals > 0`）、`incompatible-resume-state`、`pre-split-shards`。选择「保持可用但如实上报」而不是报错拒绝。`expandCombo` 固定走单进程串行后端，因此在 `engine.parallelism` 里如实写着 `requested:false`；命令行搜索在并行被禁用时打印同一原因，不再让人自己去猜。工具描述与 `skill/references/backend-commands.md` 已同步；描述符有 13 项单元测试，另有 4 项断言盯着实机 `expandCombo` 回复里的 `engine.parallelism`。
- **README 的挂载说明改成以自动挂载为准**：包内 `cordis.patch.yml` + `package.json` 的 `dsh.bundle.patch` 让插件管理器在安装时把本包收进 `dsh.profile.bundles` 并自动插入那一行，不再需要手工编辑预设的 `agent.cordis.yml`；只为不识别 `dsh.bundle.patch` 的旧运行时保留一段手工兜底（在 profile 自己的 `cordis.patch.yml` 写同样的 `insert`），并给出判定依据。`packaging` 套件新增 5 项断言把这条说法钉在 tarball 上（补丁随包、`dsh.bundle.patch` 指向它、路径可解析、补丁里就是 `package.json` 声明的那一行）。
- **测试总数（本节全部改动的净值，按实际 runner 输出核对）**：`npm test` 552 项 —— `contract` 156、`write-policy` 25、`search-order` 48、`state-stats` 114、`engine-host` 56、`combo-slice` 120、`packaging` 33。本节此前写下的 `combo-slice 98`、`state-stats 78/62`、`engine-host 55`、`combo-slice 58` 已被本轮工作取代，故一并校正；1.2.3 一节的旧计数同样按当前输出更新（并注明「后续扩到」），不假装那是发布当时的数字。

## 1.2.3 — 2026-09-29

- **修复「装上了却完全不可见」的挂载缺陷（影响所有使用者）**。此前包只声明 `dsh.plugin`（一个**待插入的行**）而没有 `dsh.bundle.patch`，也没有随包附带 `cordis.patch.yml`，于是没有任何东西把这个插件的行插进组成：工具不注册、技能不进目录、19981 没有引擎进程，而且**完全静默**（不报错、不提示）。现在随包附带 `cordis.patch.yml`（`- insert: {id: ygo-tools, name: ygo-tools-for-dsh}`），`package.json` 声明 `dsh.bundle.patch` 指向它，`files` 与 `exports` 同步收录，安装后由插件管理器自动纳入 `dsh.profile.bundles` 并挂载——不再需要手工编辑 profile 的补丁层。

- **P1：`expandCombo` 不再把主机进程拖死，搜索可切片续跑**。此前整段搜索同步跑在服务所有工具调用的引擎主机进程里：一次 `maxNodes:6000` 的真实调用跑了 120 秒并把主机打死，整个会话随后丢掉全部 16 个 YGO 工具。现在每次 `expandCombo` 都受墙钟切片约束（`timeSliceMs`，默认 15000 ms，上限 60000 ms），切片到时搜索在 DFS 帧边界干净停止，引擎既有的 `resumeState` 被主机按 job id 存放（只保留最近 N 个，`YGO_COMBO_JOB_CAP` 可调，默认 8），返回给模型的只有 `{ jobId, resumable, nodesSoFar, stopReason, slice }`；用 `expandCombo({jobId})` 继续会从断点接着搜（节点数累计增长），`expandCombo({jobId,cancel:true})` 释放。搜索完成的调用不再序列化 resumeState，也不会留下 job。切片内部每 64 个节点 `setImmediate` 让出一次事件循环，所以长任务进行中同进程的其它工具调用仍能被服务。
- 新增 `combo-slice` 测试套件（后续扩到 120 项）：切片边界与 `stopReason:"TIME_SLICE"` 的诚实报告、续跑节点累计增长、模型负载不含 resume state 且 < 100 KB、完成即不留 job、job 存储有界且淘汰最旧、以及「长任务进行中 `queryCards` 仍能应答」。
- **P0 可用性修复：引擎主机不再永久失联**。此前主机进程崩溃/启动失败后，客户端会把失败状态缓存下来（端口被占用时 `ensureStarted` 直接抛出 `ENGINE_HOST_PROTOCOL_MISMATCH`），后续任何 YGO 工具调用都只能拿到同一个错误，只能重启 DSH 桌面端。现在启动失败只缓存一个 1 秒冷却窗口，冷却后每次调用都会重新冷启动；host 子进程在就绪前退出会立刻失败而不是耗满启动超时。客户端新增 `restart()`（停机 + 清空缓存 + 冷启动），`manageEngineSession` 新增 `action:"restart"`（无需 `confirm`，会丢弃全部引擎会话），`status` 现在返回 `reachable` / `hostname` / `port` / `baseUrl` / `tokenPath` / `lastError` / `needsRestart` 诊断字段，并在主机不可达时先尝试冷启动。
- 新增 `engine-host` 测试（24 → 后续扩到 56 项），覆盖诊断字段、`restart` 契约、真实 `process.kill` 后的自动冷启动，以及「端口被外来服务占用（协议不匹配）时不再永久抛出缓存错误，而是继续探测并尝试冷启动」；`lib/dsh-skill.md`、`skill/references/backend-commands.md`、`skill/references/prompt-global.md` 已同步。
- **新增 `planRoute` 工具（第 16 个公开工具）**：把展开步骤的依赖（`requires` / `provides` / `after`）建成显式 DAG，用拓扑排序给出**多条合法顺序**，并明确报告环、无提供者的需求、未知引用、目标是否可达，以及关键路径（最少步数）。纯函数、不碰引擎，输出仍需逐步执行验证。
- **搜索结果可复现**：移动排序与路线排名的 tie-break 不再依赖 `localeCompare` 与墙钟时间，改为码点比较与「发现时节点数」；同一 seed 两次运行得到逐字节一致的路线。
- 新增纯模块 `action-order.cjs`（交换律规范化与签名分组）与 `route-planner.cjs`，配套 48 项单测。
- **工具描述补上「它能干这个」和「不许绕开它」**：一次真实会话花了 18.9 分钟、183 次工具调用，却**一次都没用插件**（自己复制 skill、全盘搜 `ocgcore.dll`、自建 harness），最后给出「水母当不了邓氏的 cost」这种错误结论——那是自建 harness 里自动应答造成的假阴性（实际邓氏① 的 cost 只要求手卡里另一只**水属性**怪兽）。现在 `analyzeReplay` 的描述写明它**离线**解析 `.yrp`/`.yrp2`/`.yrp3d`、自带内嵌引擎、不需要活的 YGOPro2 桥，且**不得手写解析**（实测同一份回放 573 ms 解析完成，而那次会话为此绕了二十分钟）；`expandCombo` 的描述写明搜索跑在引擎主机内，用它而不是自己写脚本。
- `skill/references/backend-commands.md` 新增 **Tooling Discipline**：否定性观察（「引擎不给这个动作」）只在正规工具路径下算证据；cost 与效果、选发「才能发动」与必发触发、「時」与「場合」这类只看措辞的规则，必须由卡文与工具输出裁定。
- **搜索结果不再截断卡文**：搜索路径此前只给以关键词为中心的 220 字片段，恰好会切掉决定判定的措辞（「才能发动」「可以」等）；现在同时返回全文 `effectText` 与片段 `effectSnippet`。
- **引擎客户端与主机启动行为对齐**（慢机器/CI 暴露）：客户端默认冷启动预算 15 → 30 秒（与插件 `engineStartupTimeoutMs` 的既有默认一致），`/health` 探测 1.5 → 3 秒；探测**超时**不再被当成「主机已死」，而是「端口被慢或忙的主机占用」；启动前会再探 5 秒，**端口已被占用时不再另起一个只会在 `EADDRINUSE` 上死掉的 host**，失败信息也会指明是哪一种情况。相关测试改为显式等待主机就绪（最多 60 秒），响应性断言改为「廉价调用在搜索结束**之前**得到回答」，不再卡死某个具体毫秒数。

## 1.2.2 — 2026-09-29

- **搜索核心的评分面被运行时删掉**：`removeDecisionScoringSurface` 在建好 runner 后删除 `scoringRules`/`scoreSnapshot`/`scoreSnapshotDetailed`，而搜索核心仍在调用它（`exact-search.cjs:982`），导致每次评分抛异常、所有路线退化为「评分不可用」；并行入口的默认策略 `{minScoreExclusive: 0}` 更会因此过滤掉全部候选。已移除该删除逻辑。
- **新增 `expandCombo` 工具**：让引擎自己搜索展开路线并返回 top-K 条带评分的动作序列，替代逐步试探的多次往返。新增 `combo-simulator.searchComboRoutes` 作为窄入口（单起手、单进程、无归档），并抑制 top-K 中「只差区域序号」的重复路线（透传 `topPathPolicy` + 按动作序列去重，同时报告等价放置变体数量）。
- 公开工具数 14 → 15；`lib/dsh-skill.md`、`skill/references/backend-commands.md`、`skill/references/prompt-planning.md` 与两处测试断言已同步。
- 文档与元数据：README 的安装命令改为指向本仓库与 `desktop` profile（原先指向上游与 `web` profile）；`package.json` 补上 `repository` / `homepage` / `bugs`，`skill/package.json` 补 `repository` 并标注 `directory: skill`。
- **发布物补充（同日重发）**：追加 `THIRD-PARTY-NOTICES.md`（26 个随包第三方组件、各自许可文本、游戏数据与脚本来源声明），并修复 `files` 中误删许可文件的四条排除规则。随包许可/声明文件 22 → 29 个，发布物体积 14.37 → 14.45 MB。

## 1.2.1 — 2026-09-28

### 安全与正确性

- **文件写入授权此前是空实现**：`checkFileWriteAuthorization` 永远返回成功，所有调用方的拒绝分支都是死代码。现已实现真实策略——写出目录必须落在配置的输出根（`deckDir`/`replayDir`/`routeDir`）内，文件名不得越界，根未配置时失败关闭。`exportSessionDeck` 之前完全没有越界检查，现已补上。
- **引擎主机此前无鉴权**：本机任意进程都能调用 `/tools` 与 `/execute`。现已引入 token（`x-ygo-engine-token`，constant-time 比较）并持久化到数据根，确保 DSH 重启后仍能复用存活的 host；`/health` 保持免鉴权，以便区分「端口被占用」与「主机未启动」。非 loopback 的 `engineHostname` 默认拒绝，需 `allowRemoteEngine:true` 或 `YGO_ENGINE_ALLOW_REMOTE=1` 显式放开。
- **引擎会话不再泄漏**：会话新增闲置回收（默认 30 分钟，`YGO_SESSION_IDLE_TIMEOUT_MS=0` 关闭），并在关停 host 与服务器退出时清理全部会话。
- **未知 action 不再静默降级**：新增单一 action 表，公开层校验与内部分派读取同一份数据；未知 action 返回 `INVALID_ACTION` 并附可用枚举。此前任何通过了 `confirm` 检查的未知引擎 action 都会直接关闭 host。
- **引擎地址配置单一来源**：客户端启动 host 时同时传入 host/port/token，修掉两处独立取值导致的地址不一致。

### 工具契约

- 公开工具的 `action` 描述现在写清各 action 所需字段。
- 条件必填下沉到引擎校验层：`queryCards({action:"get"})` 这类缺失入参的调用现在直接返回 `MISSING_REQUIRED_ARGUMENT`，不再进入底层工具后才失败。
- schema 校验器新增 `oneOf`（恰好匹配一个分支）、`const`、`pattern`。
- 引擎错误码透传：非 2xx 响应保留结构化 `code`/`data`，插件层不再把它们塌缩成单一错误。

### 并发稳定性

- `exact-parallel-runtime` 在 worker `kill()` 成功但未派发 `exit` 事件时不再永久挂起。
- `runParallelRandomSearch` 改为常驻消息监听并按类型分发，不再因一条 `progress` 消息判定 worker 失败。

### 分发体积

- 打包排除运行时不会读取的产物：vendored 依赖的 `.d.ts`、`.map` 与文档，以及 WindBot 的 C# 源码目录（运行时使用预编译的 `WindBot.exe`）。
- 未压缩 82.28 MB → 70.90 MB，tgz 16.98 MB → 14.42 MB，文件数 15,275 → 14,529。已验证 26 个 vendored 包的 67 个入口文件与全部 14,135 个 Lua 脚本均保留。
- Release 额外附带稳定命名的 `ygo-tools-for-dsh.tgz`，README 因而可以链接 `releases/latest`，不再随版本漂移。

### 工程

- 新增回归测试套件 `tests/`（工具契约、文件写入策略、引擎鉴权与会话回收、打包完整性）；release 流程在打包前运行测试，并校验 tag 与 `package.json`、`skill/package.json` 版本一致。
- `skill/package.json` 版本此前停留在 1.0.0，且声明了 15 个不存在的测试脚本和多个不存在的路径，现已校正。
- 清理不可达代码：`skill/backend/index.mjs` 从 177 行收到 14 行，只保留插件入口唯一需要的 `createModelToolHost`。原文件另外定义或转发了 30 个符号（`createYgoSession`、`executeTool`、`listTools`、`runToolSequence`、`loadPromptReference` 等），由于包的 `exports` 只暴露 `lib/index.js`，全仓无任何文件引用它们。被移除的实现保留在 git 历史中。

## 1.2.0 — 2026-08-21

- 项目更名为 **YGO Tools for DSH**。
- 包名改为 `ygo-tools-for-dsh`，DSH 挂载 ID 统一为 `ygo-tools`。
- 发布目录、安装包文件名和 GitHub Release 资源名称统一为 `ygo-tools-for-dsh`。

## 1.1.2 — 2026-08-20

- 放宽 DSH peer 兼容范围至 `>=0.1.0-rc.6 <0.2.0`，兼容 rc7/rc8 的预发布版本。
- 保持 14 个聚合工具和多效果卡编号映射修复不变。

## 1.1.1 — 2026-08-19

- 修复多效果卡的 `Stringid` 与卡面①②③编号错位：不再把引擎序号直接当作卡面效果序号。
- 发动/连锁动作现在携带明确的卡面效果引用或引擎效果标识；无法唯一映射时保留完整卡牌原文，不显示空效果或猜测编号。
- 新增真刀竹光、守护者之力、太阳神之翼神龙-不死鸟等多效果卡的通用回归校验。

## 1.1.0 — 2026-08-19

- 将模型可见工具收敛为 14 个功能域工具，降低 DeepSeek 上游的工具数量与 schema 负担。
- 卡组、数据源、YGOPro2、观察、检查点、录像、Combo、导出和引擎管理通过显式 `action` 参数聚合；底层规则能力保持不变。
- 固定起手合并进 `resetGame.fixedOpening`，录像解析与上下文构建可由 `analyzeReplay({action:"analyze"})` 一次完成。
- 删除旧公开工具名称的技能指引和发行说明，DSH 仅注册新的 14-tool schema。

## 1.0.2 — 2026-08-16

- 修复通用多卡选择标签：枚举式 `SelectCard` 选择现在在标签中按响应顺序列出每个候选序号与卡名，不再把全部组合显示为相同的“选择 N 张卡片”。
- 同名卡通过候选序号保持可区分；超大选择集继续使用原有 factorized 分页提交机制，避免组合爆炸。
- 新增 6 个候选选 2 张的 30 组合回归测试，并验证模型可见的合法动作输出中全部标签唯一。

## 1.0.1 — 2026-08-14

- 修复卡库更新的跨盘 EXDEV：数据根目录（cache/replays/routes/decks）默认改为 `$DSH_HOME/ygoai`，确保与插件资源目录同盘，更新器可以完成原子 rename。
- 导出 `resolvePluginConfig` 便于集成测试。

## 1.0.0 — 2026-08-14

首个 DeepSeek Harness 发布版。

- 内嵌完整 YGOagentskill v1.0.0（backend、runtime、resources、vendor、references、integrations、tests、examples）。
- DSH 插件 `ygoai`：注册完整模型工具集与 `ygoagentskill` skill（带 references 资源基目录）。
- 热拔插引擎：薄客户端 + detached 引擎主机进程（127.0.0.1:19981），按需启动、显式主机停机、崩溃后自动重启。
- 会话按 DSH agent id 隔离（`dsh-<agentId>`），跨插件重载与 DSH 重启保留（引擎进程存活期内）。
- 输入 schema 从后端 JSON Schema 转换为 DSH 参数 DSL，权威校验仍在引擎主机。
- 输出目录（cache/replays/routes/decks）默认落在 `~/.dsh/ygoai`，全部可通过配置或环境变量覆盖。
