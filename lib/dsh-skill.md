---
name: ygo-tools-for-dsh
description: 游戏王专用技能：通过 16 个聚合式 YGO 工具完成卡查、卡组管理、持久引擎对局、固定起手、检查点、展开路线搜索与依赖排序、YGOPro2 AI.Server 对战与录像分析导出。普通工作纯内存，不创建脚本、报告或日志。
---

# YGO 对战引擎工作方式

本预设挂载 `ygo-tools-for-dsh`，只向模型注册 16 个聚合式 YGO
工具。引擎首次调用时自动启动并跨 DSH 重启保留。模型不得经 shell、
eval、Node import、HTTP、CLI 或包装脚本调用后端。

## 工作流

1. 每个 YGO 任务先调用 `manageEngineSession({action:"status"})`。
2. 直接使用注册工具；不要枚举内部后端命令，也不要创建或传递
   `sessionId`。
3. 卡查用 `queryCards`；卡组用 `manageSessionDeck`；场面与合法动作使用
   `observeDuel`；分支回滚使用 `manageCheckpoint`。
4. `executeAction` 成功后直接消费返回的 `state` 和
   `nextDecision.actions`，仅在缺失、截断、失败、中断或无进展时重新
   `observeDuel`。
5. 录像使用 `analyzeReplay`，旧 Combo 使用 `analyzeCombo`，用户明确要求
   写文件时才调用 `saveArtifact`。
6. 只有 DSH 直接报 `manageEngineSession` 未知才证明插件注册失败；此时
   停止并报告，绝不自建后端访问路径。

## 16 个公开工具

- `queryCards`: `get` / `search`
- `manageCardDataSources`: `inspect` / `refresh`
- `manageYgoPro2`: `discover` / `status`
- `getBanlistContext`
- `manageSessionDeck`: `set` / `get` / `check` / `edit` / `export`
- `resetGame`
- `observeDuel`: `state` / `actions`
- `executeAction`
- `simulateActions`
- `expandCombo`: 让引擎自己搜索展开路线，返回 top-K 条带评分的动作序列。
  每次调用都有墙钟切片（`timeSliceMs`，默认 15000，上限 60000）：切片用完会
  干净停止并返回 `resumable:true` + `jobId` + `slice.consumedMs/remainingMs`；
  用 `expandCombo({jobId})` 接着搜（节点数会继续增长），用完再
  `expandCombo({jobId,cancel:true})` 释放。`stopReason:"TIME_SLICE"`、
  `completed:false`、`ordersTruncated:true` 表示路线只是部分结果。
  resume 状态只存在引擎主机上，绝不放进工具参数。
   续跑会沿用该 job 自己的起手：`seed` / `openingCodes` / `drawCount` 原样取回并
   回显（`drawInputsSource:"job"`），所以每一片搜的是同一个手牌，
   `slice.nodesAtSliceStart` 接着上一片的 `nodesSoFar`。续跑时不需要再传这几个
   参数；若传了且与 job 不一致，会被忽略并在 `ignoredDrawInputs` 里说明实际用了
   job 的哪个值（不会照着新的 seed/手牌另搜一副）。
  续跑次数有上限（`YGO_COMBO_MAX_CONTINUATIONS`，默认 32；回复给出 `continuations` /
  `continuationLimit`）：超限会直接返回 `COMBO_CONTINUATION_LIMIT` 并丢弃该 job，
  需要更多就重新起一次搜索。`slice.nodesThisSlice` 是本片新扩展的节点数，
  `slice.revisitedNodes` 是本片为重建「链上已经到过的局面」而重新执行的引擎步数
  （0 既可能是没重放、也可能是 runner 未上报，只当时延参考）。
  `expandCombo` 固定单进程串行搜索：`engine.parallelism{requested,active,disabledReason}`
  会如实说明是否请求了并行、是否真的并行、以及被禁用的原因。
  可选 `measureStates:true`（默认关）只加统计、不改搜索：返回的 `statistics`
  给出 `nodes` / `distinctStates` / `duplicateRate`（严格键＝场面＋当前合法动作集＋表侧/里侧与表示形式）、
  `coarseDistinctStates` / `coarseDuplicateRate`（宽松键＝只看场面，忽略动作集与卡组顺序，
  两率之差就是「场面相同但选项已不同」的重复量）、`worstRepeat`、
  `terminals{visits,distinct,duplicateRate}`、`topK{routes,distinctTerminals,largestVariants}`，
  以及 `terminalCountRaw` 与 `terminalCountDistinct`。同一 seed 下开关它，路由逐字节一致；
  每个路由还会带上 `terminalKey` / `terminalGroup`（重复时含 `terminalVariants`），
  同一终局的不同动作顺序被保留并成组标注，不会被合并掉。
- `planRoute`: 按依赖排出展开步骤的合法顺序（可给多条），或解释为什么排不出
- `manageCheckpoint`: `save` / `restore` / `list` / `delete`
- `analyzeReplay`: `parse` / `context` / `analyze`
- `analyzeCombo`: `parse` / `adapt`
- `saveArtifact`: `replay` / `route`
- `manageEngineSession`: `status` / `restart` / `clear` / `shutdown`

除 `expandCombo` 外，每个工具回复的 `data` 都带 `elapsedMs`：引擎主机处理该次调用的
墙钟毫秒（整数），从工具分派开始量到回复构造完成，**不含**插件与主机之间的 HTTP 传输
与 JSON 序列化，所以调用方自己的往返总是更长一点。`expandCombo` 不加它，是因为它已经
用 `searchElapsedMs` / `slice.consumedMs` 报了搜索耗时。

## 硬性规则

- 以工具输出为准，不凭记忆断言卡文、卡组归属、合法动作、场面或录像。
- YDK 文本原样传给 `manageSessionDeck({action:"set",ydk})`，绝不手工解析。
- 固定起手通过 `resetGame({fixedOpening:[...]})` 设置，不补随机牌。
- 真实对局必须显式使用 `duelBackend:"ygopro2"`、对手配置和先后手，并以
  `manageYgoPro2({action:"status"})` 的 `liveDuelBridge:true` 为准。
- AI.Server 对局不可回滚；固定起手、模拟和检查点只适用于内嵌 runner。
- 用户要求结束并导出真实对局时，才调用
  `saveArtifact({action:"replay",surrenderIfRunning:true,...})`。
- 默认纯内存，不写路线、录像、报告、日志、调试转储或工作流文件。
- `manageEngineSession` 的 `clear` / `shutdown` 必须有明确需求并传
  `confirm:true`。
- 引擎主机不可达或卡死时，用 `manageEngineSession({action:"restart"})`
  停机并冷启动（不需要 `confirm`，但会丢失全部引擎会话）；`status` 会
  自动尝试冷启动，并返回 `reachable` / `port` / `tokenPath` / `lastError`
  / `needsRestart`。
- 不创建数值化对局评分；直接比较已验证的资源、封锁、区域和合法后续。
