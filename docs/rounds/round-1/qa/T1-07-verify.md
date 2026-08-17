# T1-07 验收报告 · HarnessAdapter 6 动作 + AuditPort pi 实现（verifier 独立复核）

> 复核人：verifier（round-1，2026-08-18；第二轮修复复审同日）
> 对象：git 未提交改动——4 个 M（package-lock.json、pi-ext 的 package.json / tsconfig.json / vitest.config.ts、pi-ext/src/index.ts）+ untracked（`packages/core/src/adapter/`、`packages/core/src/index.ts`、pi-ext 的 harness-adapter.ts / harness-adapter.test.ts / tool-translation.ts / test-helpers.ts / ports/）
> 方法：干净态复跑门禁 + verifier 自写 8 条临时驱动（断言全部自造，仅复用 stub 模型基建——其记录逻辑为 `JSON.stringify(context)` 原样快照无过滤；跑完即删）+ pi 0.84.2 `.d.ts`/`.js` 源码实证抽验 + 红线 grep + 前置事实专项验证
> 范围声明：ADR-001 已挂起架构之争，本卡按现状形态（core 接口 + pi-ext 实现）验收，架构重组不在本卡范围

---

## 一、干净态门禁复跑

`rm -rf node_modules`（根 + core + pi-ext）→ `npm install` → `npm run typecheck` → `npm test`，原文数字：

| 步骤 | 结果 |
|---|---|
| `npm install` | exit 0，`up to date, audited 201 packages`（esbuild 等 postinstall 的 allow-scripts 警告为环境策略提示，非错误；pi 包安装成功） |
| `npm run typecheck` | 3 workspaces（core / pi / web）`tsc --noEmit` 全过，零错误 |
| `npm test` | **Test Files 14 passed (14)，Tests 193 passed (193)**，Duration 1.53s |

**pi 精确 pin 三重确认**：`packages/pi-ext/package.json` 为 `"@earendil-works/pi-coding-agent": "0.84.2"`（无 `^` 前缀，精确 pin，且是 pi-ext 唯一 dependencies 项）；`package-lock.json` version 0.84.2 + resolved 指向 `pi-coding-agent-0.84.2.tgz`；干净态实装 `node_modules/.../package.json` version 0.84.2。

零回归对账：193 = T1-06 验收基线 **177** + 本卡新增 **16**（harness-adapter.test.ts 13 + audit-port.test.ts 3）。与实现者声明「193/193（177 零回归 + 16 新增）」一致。驱动文件删除后干净态复跑即上表。

## 二、独立驱动明细（8/8，临时文件已删）

| # | 驱动 | 结果 |
|---|---|---|
| V1 | **registerTool 全链路**：registerTool 注册 echo 工具 → stub 发起 toolCall → pi 真执行 execute → args 原样到达（`{msg:"roundtrip", n:42}` 字符串+数字类型零漂移）→ 工具输出 `V_ECHO_OUT[roundtrip]` **回灌进第二次 LLM 调用的上下文**（stub.calls[1].serialized 命中）→ 模型工具面含该工具 | 过 |
| V2-1 | **readSessionStream 态一（全量回放）**：两轮对话后读流，恰 6 条（2 setup + 4 message），message 条目 payload 携带消息体（alpha/beta 可见） | 过 |
| V2-2 | **态二（afterEntryId）**：任意切点（第 3 条处切），输出恰为该条目之后的尾部，逐 id 相等 | 过 |
| V2-3 | **态三（直播，事实记录版）**：见四·P1-1——排干快照全量后并发 sendMessage，1.2s 内直播通道无任何条目到达（两种时序「先写后挂」「先挂后写」均复现）；但 `getEntries()` 增至 6 条（条目确实写入，回放可见、直播不可见）；挂起态 `return()` 2s 内立即返回（不死锁） | 过（断言的是缺陷事实本身） |
| V3 | **AuditPort 双验（持久会话）**：append 后 `getEntries()` 与 **JSONL 文件**双出现 `type:"custom"` 行（customType="next-step"、data.ns="next-step"、data.kind="approval_request"、changeId 命中）；**不进上下文**——第二次 LLM 调用 serialized 无 marker 无 "approval_request"（M2 机制物理证据） | 过 |
| V4 | **前置事实**（纯 custom 不落盘）：见五·事实 1 | 过 |
| V4b | **补充正面事实**：pi 原生路径（不经 adapter）factory 内 `pi.on("context")` 延迟 `pi.appendEntry("verifier",{m:1})` → `session.subscribe` 订阅者实时收到 custom 条目（entry_appended 可达） | 过 |
| V5 | **六动作纪律**：`Object.keys` 恰 `startSession/sendMessage/registerTool/readSessionStream/spawnSubagent/getContextUsage` + `dispose`；实现对象可赋值给 L1 `HarnessAdapter`（签名零漂移，编译期） | 过 |

实现者测试全部 193 项在干净态同样通过（含其 13 项 harness-adapter 断言与 3 项 audit-port 断言），其中 startSession 透传 / excludeTools / spawnSubagent 伪进程参数组装与回收 / getContextUsage 上下文快照等断言与源码落点吻合，未发现除四·P1-2 外的空洞断言。

## 三、pi API 实证抽验（对照 node_modules 内 .d.ts/.js）

| 实证点 | 证据 | 判定 |
|---|---|---|
| `DefaultResourceLoaderOptions` 含 `cwd` / `agentDir` / `extensionFactories?: InlineExtension[]` / `systemPromptOverride?: (base) => string` / `appendSystemPromptOverride?: (base: string[]) => string[]` | `dist/core/resource-loader.d.ts` L67-118 | 实现者用法正确；「完全替换 + 不追加 APPEND_SYSTEM.md」的 override 组合合法 |
| `context` 事件 `{ type:"context"; messages: AgentMessage[] }`，注释「Fired before each LLM call」；`pi.on("context", ...)` 在 ExtensionAPI；`InlineExtension = ExtensionFactory \| {name,factory}` | `dist/core/extensions/types.d.ts` L499-503、L879、L1108 | 动作 6 数据源正确；「每次 LLM 调用前的 messages 快照」表述准确（测试里 entryCount=1→3 的快照时序也与之自洽） |
| （附验）`ExtensionAPI.registerTool` 与 `ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx) → Promise<AgentToolResult>`，`AgentToolResult = { content, details, usage?, ... }` | types.d.ts L344-377、L902；pi-agent-core `types.d.ts` L316-325 | tool-translation 的参数序、`{content, details:undefined}` 返回结构正确 |
| （附验）`SessionManager.appendCustomEntry(customType, data?)` / `getSessionFile(): string \| undefined` | session-manager.d.ts L208、L225 | audit-port 落点存在 |

结论：实现者自报的四点 pi API 实证抽验两条 + 附带两条全部属实，未瞎绕。

## 四、分级 findings

### P1-1（FAIL 项）· readSessionStream 直播通道不覆盖对话消息——动作 4「直播 + 回放同通道」的直播侧实质缺失

- **行为证据**（verifier 独立复现，两种时序均挂）：排干回放快照全量后并发 `sendMessage`，直播通道 1.2s 内零条目到达；同时 `getEntries()` 从 4 增至 6（q2 的 user+assistant 已写入）。条目进了回放、进不了直播。
- **根因**（pi 0.84.2 源码实证）：`session.subscribe` 的订阅者收到两类来源的事件——(a) agent 循环经 `_handleAgentEvent`（`agent-session.js` L340-399）转发的 `message_start`/`message_end` 等 **Message 级事件**（对话消息走这条，且**先转发后持久化**）；(b) **`entry_appended` 仅一处发射**：`ExtensionAPI.appendEntry`（L1864-1870）= `sessionManager.appendCustomEntry` + `_emit(entry_appended)`。而实现（`harness-adapter.ts` L196-201）只过滤 `entry_appended` → 对话消息（user/assistant/toolResult，会话流主体）永远进不了直播；当前接线能直播到达的只有「经 ExtensionAPI.appendEntry 写的 custom 条目」。
- **后果**：概设 §4 动作 4 注释「直播 + 回放同一条通道」对 L1 消费者（T1-08 web-panel 会话流、第二期 M2 sourceRef）承诺的直播态，在对话条目上不成立。修复路径明确且成本可控：subscribe 同时监听 `message_end`（注意时序——订阅者收到事件时该条目尚未 appendMessage 持久化，翻译 SessionEntry 需自行构造而非查 getEntries），或事件通知 + getEntries 差量。
- **边界澄清**（公平记录）：回放侧（全量/afterEntryId 去重、先订阅后快照的间隙防丢、手写 iterator 防死锁、return 立即唤醒）实现质量高，全部实证通过；缺陷仅在直播侧的事件类型选择。

### P2-1（FAIL 项）· 实现者的直播测试是假阳性，为 P1-1 提供了错误绿灯

`harness-adapter.test.ts` L190-220「直播」用例：排干循环只取 2 条（快照 4 条中的前 2 条 setup）即 break，随后的 `await iterator.next()` 吐出的是**回放快照余量**（q1 轮 user message，订阅前已存在的条目），而非直播事件；断言 `received[0] !== replay[0]` 恰好被快照余量满足。测试名为「直播：订阅后新写入的条目实时到达」，实际未验证任何直播路径。verifier 排干全量后同款操作即挂死，证明该绿灯不实。修复 P1-1 时须同修此测试（排干至快照耗尽再断言直播到达）。

### P3（不阻塞，记录）

1. `registerTool` 为 adapter 级注册、下一 `startSession` 生效（无 SDK 级动态注册）——已在代码注释中如实声明并与官方范式一致，非缺陷。
2. `spawnSubagent` 以注入伪进程单测（不真起子进程）——符合卡内「实现 + 单测不接线」边界；真实进程链路留待第二期 M4 接线时验证。
3. `getContextUsage` 的 totalTokens 在无 context 快照时回退会话累计值——语义已在注释声明，与 P2-7 的消费预期需对齐（届时若需「当前上下文占用」严格语义再收敛）。

## 五、对 T1-08 / T1-11 的前置事实清单（全部经独立验证，源码 + 行为双证）

1. **纯 custom 条目不触发 JSONL 落盘，首条 assistant 消息到场后才写文件（此前缓冲全量补写、不丢）**——实现者发现，**verifier 独立验证成立**。源码：`session-manager.js` `_persist`（L724-750）：`fileEntries` 无 assistant 时直接 return 不写文件；首条 assistant 到场时 `openSync(wx)` 全量写出缓冲后置 `flushed`。L1137-1138 注释明说「creates the file on the first assistant response」。行为：持久会话 append custom 后 `getSessionFile()` 路径已定但文件不存在；一轮对话后文件出现且**含此前那条 custom**。→ **直接影响 T1-11**：web-panel.jsonl 审计通道若假设「append 后文件即刻可见」，在「会话刚建、尚无对话」的场景会读空；需先触发一轮对话、或轮询等待、或接受延迟可见。
2. **（新发现）对话消息不产生 `entry_appended`，只发 `message_start`/`message_end`**——见 P1-1。→ T1-08 web-panel 若要实时显示 agent 对话流，不能依赖当前 readSessionStream 直播实现。
3. **（新发现）AuditPort 直写 SessionManager 不进直播**：`createEntryAuditPort` 用 `sessionManager.appendCustomEntry`（无 emit）。审计条目**回放可见（getEntries/JSONL）、直播不可见**。→ T1-11 若要实时审计流：改走 ExtensionAPI.appendEntry（会 emit entry_appended，见事实 4）、或 watch JSONL 文件、或轮询 getEntries。
4. **（正面事实）`ExtensionAPI.appendEntry` = `appendCustomEntry` + `_emit(entry_appended)`**：经 extension factory 内 `pi.appendEntry` 写的 custom 条目能实时到达 subscribe 订阅者（V4b 行为验证）。→ 若 T1-11 要「审计条目实时进会话流」，让 AuditPort 的写路径改经 ExtensionAPI.appendEntry 即可获得直播可见性（同时保持不进 LLM 上下文——两条路径都只写 custom 条目，均被 buildSessionContext 排除，V3 已证）。
5. **时序细节**（改 subscribe 消费 message_* 时必读）：`_handleAgentEvent` 先把 `message_end` 转发给订阅者、**后**做 `appendMessage` 持久化——订阅者收到事件时 `getEntries()` 里还没有该条目。

## 六、红线审计

| 红线 | 结果 |
|---|---|
| `packages/core/` 零 `@earendil` | 过——命中仅 2 处**字面量自检测试**（ports.test.ts、pending-gate-service.test.ts 的 grep 断言，卡内明示豁免）；core 非测试源码零命中；barrel `export type *` 零 pi import |
| `packages/pi-ext/` 命中仅限 package.json 与 src | 过（`--include=*.ts,*.json` 排除 node_modules 后命中面 = package.json + 7 个 src 文件） |
| pi-ext 唯一运行时依赖 = pi | 过（dependencies 恰 1 项，vitest/typescript/core 全在 devDependencies） |
| 无第 7 动作 | 过——L1 接口恰 6 方法；实现 `Object.keys` = 6 + `dispose`，dispose 有注释注明「L2 生命周期管理…不是第 7 个动作」（harness-adapter.ts L113-116） |
| L1 接口与概设 §4 逐字一致 | 过——方法签名、10 字段 SessionStartOptions、8 个配套类型逐行比对一致；文件路径 `packages/core/src/adapter/harness-adapter.ts` 与概设 §5 布局图一致 |
| 6 动作签名无漂移 | 过——实现可赋值给 L1 接口（V5 编译期 + 运行时 keys 双验） |

## 七、卡假设出入裁决：T1-01 未建 adapter 目录、本卡新建 L1 接口

- **事实**：`git ls-files packages/core/` 证实 T1-01 已跟踪文件中无 `src/adapter/`、无 `src/index.ts`（barrel）。任务卡「接口类型沿用 T1-01 建仓时 L1 侧定义」的假设不成立，实现者按概设 §4 新建。
- **裁决：归属正确**。概设 §4 明文「接口定义在 **L1**（零 pi import）」，§5 布局图标明 `core/src/adapter/ # HarnessAdapter 接口类型（§4）`——新建文件正是概设规定的位置与内容（逐字一致），不是实现者擅自挪层。barrel（`core/src/index.ts`）新建同理：pi-ext 经 `@pgoone/next-step-core` 引 L1 类型的必要接线，且 vitest alias / tsconfig paths 同步映射（中文目录名 percent-encode 的坑已在注释登记）。
- **commit 建议**：无需回改 T1-01（已 commit 的历史不动）；本卡 commit message 的 body 中补一句「T1-01 遗留的 adapter/ 目录与 core barrel 由本卡按概设 §4/§5 补建」，让 git 考古时能对上「卡说沿用、实为新建」的出入即可。

---

## 八、第二轮复核（P1-1 / P2-1 修复复审，2026-08-18 同日）

实现者修复方案：subscribe 监听 5 类触发事件（message_end / entry_appended / thinking_level_changed / session_info_changed / compaction_end），事件**只做唤醒**，条目经 `queueMicrotask` 差量比对 `getEntries()` 入队（利用「_emit 转发与 appendMessage 同一同步块，microtask 时点条目必已入表」的时序事实）；直播与回放同源同 id。verifier 自写 5 条第二轮驱动（R1-R5，临时文件已删）：

| # | 驱动 | 结果 |
|---|---|---|
| R1 | 原始复现路径重跑：排干快照全量 4 条后并发 sendMessage，直播实时到达 2 条 message（id 与回放无重叠、payload 含 q2 与 "second"） | **过**（修复有效） |
| R2 | 同源同 id：直播条目 id 全部真实存在于 getEntries()，恰 2 条无重复投递（500ms 安静期后仍 2 条） | 过 |
| R3 | afterEntryId + 直播交互 | **败——发现新 P1-2（见下）** |
| R4 | AuditPort 直写条目的直播时序 | 过（前置事实 3 更新，见下） |
| R5 | 直播静默挂起时 return() 立即返回 | 过 |

P2-1 修复到位：重写的直播测试（harness-adapter.test.ts L190-231）排干回放快照全量 4 条后才断言直播到达，type/message 双断言 + id 与回放无重叠 + 3s 超时 reject——假阳性判据全部满足，直播再失效时该测试会真失败。

### P1-2（FAIL 项，修复引入的回归）· afterEntryId 模式下切点之前的条目被误投直播流

- **行为证据**（R3 稳定复现，非竞态）：`afterEntryId = all[1].id` 订阅 → 回放正确吐尾部 all[2..3] → 直播侧先到达的是 `all[0]`（model_change）与 `all[1]`（thinking_level_change）——**切点之前的旧条目**，然后才轮到新条目。断言 `["message","message"]` 实收 `["model_change","thinking_level_change"]`。
- **根因**：`harness-adapter.ts` prepareReplay 的 continue 分支（L236-239）跳过切点前条目时**不 `seen.add`**；其末尾 `runDiff()`（L245）全量遍历 `getEntries()` 按 seen 判新，切点前条目不在 seen → 被当作新条目入直播队列。全量模式（afterEntryId === undefined）不受影响（全部条目都 seen.add），R1/R2/R4 通过即证。
- **影响**：afterEntryId 是 L1 接口契约参数（概设 §4 动作 4 签名），断线续读场景（T1-08/T1-11）直接踩——消费者从切点续读会先收到一批切点之前的旧条目。
- **属回归**：修复前的旧代码直播只由订阅事件 push、getEntries 既有条目不产生事件，无此缺陷；系本次重构引入。
- **修复方向**：prepareReplay 的 continue 分支补 `seen.add(entry.id)`（切点前条目标记已见、不入回放即可）；全量模式行为不变。修后建议补一条 afterEntryId 直播变体测试（切点续读 + 直播到达，断言首条直播条目为新条目而非切点前旧条目）。

### 前置事实 3 更新（修复后语义，供 T1-11 引用）

AuditPort 直写（`sessionManager.appendCustomEntry`）的条目：**直播「延迟可见」**——直写本身无触发事件、直播通道暂不达（R4 实证 800ms 静默）；下一个触发事件（任一 TRIGGER_EVENTS，如下一轮 sendMessage 的 message_end）到来时差量比对**一并补上、不丢**（R4 实证 custom + 2 条 message 同批到达）。即修复后审计条目「最终一致可见」；若 T1-11 需要「append 即刻直播可见」，仍需走 ExtensionAPI.appendEntry（前置事实 4 路径）。

### 门禁复跑（第二轮）

typecheck 0 错误；全仓 **194/194 全绿**（= 193 基线 + 实现者重写直播测试净增 1 条；实现者消息称「193/193」为数字小误差，方向是多一条测试非少，不阻塞）。verifier 临时驱动删除后复跑即此数。

---

## 九、第三轮复验（lead 四点要求 + P1-2 修复复核，2026-08-18 同日）

实现者第二轮动作：P1-2 修复（prepareReplay continue 分支补 `seen.add`，注释标明 P1-2）+ 补齐两时序直播用例与 afterEntryId 直播变体（harness-adapter.test.ts 增至 15 it）。verifier 自写 5 条第三轮驱动（L 系列，临时文件已删）+ 破坏敏感性实验：

| # | 驱动（lead 复验要求） | 结果 |
|---|---|---|
| L1-A | 时序 A「先挂后写」（第一轮挂死场景原样重放）：next 先挂住内部 wake 再并发 sendMessage——直播立即到达 2 条 message（payload 含 q2/"two"） | 过 |
| L1-B | 时序 B「先写后挂」（最严苛）：sendMessage 整个 run **完全结束后**消费者才开始 next——差量补齐 2 条，不依赖消费时序 | 过 |
| L2-1 | 事件密集连发：一次响应带 2 个 toolCall → assistant + 2×toolResult + 后续 assistant 连续 message_end 连发——直播全收（OUT-1/OUT-2/after tools 俱到），id 无重复 | 过 |
| L2-2 | 消费者滞后 + 多轮连发：订阅后沉默，3 轮消息全部写完才开始消费——6 条 message 一次性补齐，id 唯一 | 过 |
| L4 | P1-2 修复复核（第二轮 R3 原场景重放）：afterEntryId 切点续读，直播到达的 2 条均为新 message，切点前旧条目（含 2 条 setup）绝不出现 | 过 |
| L3 | **破坏敏感性实验**：临时将 TRIGGER_EVENTS 中 `"message_end"` 改名禁用 → 直播两用例（afterEntryId 直播变体、直播中途订阅）**真红**（3s 超时 "live entry not delivered"），回放用例不受影响仍绿；恢复后 15/15 全绿——测试敏感性确认，假阳性教训闭环 | 过 |

**lead 第 2 点（差量拉空边界）的裁决**：实现无显式重试/等待，但设计上免疫拉空——(a) 时序保证：pi 的 `_emit` 转发与 `appendMessage` 在同一同步块（agent-session.js L340-399，第一轮已源码实证），`queueMicrotask` 必在该同步块结束后执行，此刻条目必已入 `getEntries()`；(b) 全量差量（非增量游标）：`runDiff` 每次全量扫 `getEntries()`，即使某次拉空（理论不发生），后续任一触发事件再扫即补，最终一致；(c) `diffScheduled` 合并连发为一次全量扫描，不丢窗口。L2-1/L2-2 行为实证（最不利的滞后消费场景全量到达）。

### 门禁复跑（第三轮）

typecheck 0 错误；全仓 **195/195 全绿**（= 177 零回归 + pi-ext 18：harness-adapter 15 it + audit-port 3；实现者消息称 194 系其发消息时点尚未计入最后一条用例，实际以本轮复跑为准）。破坏实验恢复后 `message_end` 在位确认、git 状态与实现者产出一致，verifier 零残留。

---

## 结论

**第三轮（最终）**：lead 四点复验全过——两时序场景独立复跑通过（先挂后写/先写后挂均实时到达，第一轮的两个挂死场景消除）；差量方案边界裁决为「时序保证 + 全量差量 + 触发合并」三重免疫拉空，密集连发与消费者滞后场景行为实证不丢不重；破坏敏感性实验证明直播测试在实现失效时真红（假阳性教训闭环）；P1-2 修复经第二轮 R3 原场景重放复核通过（切点前旧条目不再误投，实现者并按建议补了 afterEntryId 直播变体测试）；门禁 typecheck 0 错误、全仓 195/195。三轮累计：P1-1（直播不覆盖对话消息）、P2-1（测试假阳性）、P1-2（afterEntryId 回归）全部修复并独立验证。

**第一轮通过项（不变）**：干净态门禁 193/193 对账吻合；pi 精确 pin 0.84.2 三重确认；AuditPort 双验 + 不进 LLM 上下文；registerTool 全链路；六动作纪律（恰 6 + dispose）；红线六项（core 零 pi import、pi-ext 唯一命中面、唯一运行时依赖）；卡假设出入裁决（adapter 目录归属 L1 正确，commit body 补登记即可）；五条前置事实交付 T1-08/11（事实 3 终态语义见 §八：AuditPort 直写条目直播延迟一致可见，要「即刻直播」走 ExtensionAPI.appendEntry）。

STATUS: PASS —— 三轮复核闭环：第一轮两项 findings（P1-1 直播不覆盖对话消息 / P2-1 测试假阳性）与第二轮新发现 P1-2（afterEntryId 切点前条目误投）全部修复并经独立驱动验证（第三轮 5/5：两挂死时序重放、密集连发不丢、消费者滞后补齐、切点续读干净）；破坏敏感性实验证直播测试真红（假阳性闭环）；门禁 typecheck 0 错误、全仓 195/195（177 零回归 + 18）；pi 精确 pin 0.84.2、红线六项、AuditPort/registerTool/六动作纪律/归属裁决全部通过；五条前置事实（含事实 3 终态语义）已交付 T1-08/T1-11
