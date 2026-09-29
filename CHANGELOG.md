# Changelog

## Unreleased

- **新增 `planRoute` 工具（第 16 个公开工具）**：把展开步骤的依赖（`requires` / `provides` / `after`）建成显式 DAG，用拓扑排序给出**多条合法顺序**，并明确报告环、无提供者的需求、未知引用、目标是否可达，以及关键路径（最少步数）。纯函数、不碰引擎，输出仍需逐步执行验证。
- **搜索结果可复现**：移动排序与路线排名的 tie-break 不再依赖 `localeCompare` 与墙钟时间，改为码点比较与「发现时节点数」；同一 seed 两次运行得到逐字节一致的路线。
- 新增纯模块 `action-order.cjs`（交换律规范化与签名分组）与 `route-planner.cjs`，配套 46 项单测。

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
