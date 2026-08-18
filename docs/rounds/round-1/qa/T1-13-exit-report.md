# T1-13 出口判据报告（round-1 收官 · 第一期出口逐项打勾）

> 卡：`docs/rounds/round-1/tasks/T1-13-WebE2E与出口判据收官.md`
> 基准：PRD 正本 §10 第一期出口判据（AC-1.1~1.4 / F1 纯 CLI / EXTERNAL_MODIFIED / presentation 承重）
> 场景剧本：PRD S1–S5；正本 §11 启动指令硬性要求（自检清单可执行项）
> 证据链：`apps/web/e2e/`（run-e2e.sh 编排：真浏览器 E2E 驱动 + fixture 种子 + CLI 读侧 + S5 真机冒烟）
> 执行：round-1 实现队员（2026-08-18）｜真机 S5 冒烟由 verifier 双层验收时独立复跑

---

## 零、结论速览

| 判据（正本 §10 第一期出口） | 结论 | 证据位置 |
|---|---|---|
| AC-1.1~1.4 全绿 | **PASS** | 本报告 §1.1（E2E + S5 冒烟 + T1-10 独立验证引用） |
| F1 在纯 CLI 端到端成立 | **PASS** | §1.2（真模型冒烟 + E2E E5/C6 跨通道 + T1-10 实证引用） |
| EXTERNAL_MODIFIED 保护实测有效 | **PASS** | §1.3（S4 全场景 12 条断言） |
| presentation 纯数据 + 通用渲染器承重实证通过 | **PASS** | §1.4（结构证据 + S1–S4 真浏览器 + 通道①双端逐字段） |

**四条判据全 PASS，本期实现收官，等待双层验收（verifier 复核 + 真机 S5 人工清单）。**

---

## 一、判据逐条证据

### 1.1 AC-1.1~1.4（正本 §6 M1，逐条）

| AC | 断言 | 证据（命令/断言名 + 结果） |
|---|---|---|
| AC-1.1 只读工具结构化结果 | 会话中调用三只读工具拿到结构化 JSON，无需人工粘贴 | E2E `C6-⑤/⑥`（list_artifacts/get_artifact_history 与 Web API 逐字段一致）、`E5-⑪~⑬`、`C6-⑥b/⑦`（create 结构化返回 + list_my_artifacts 命中 e2e-cli-actor 名下）——均 PASS；S5 冒烟 `tool.call` 留痕三只读工具真实调用（真模型）；T1-10 verifier 独立驱动 13/13（含结构化 JSON 回灌 LLM 上下文直查） |
| AC-1.2 diff 与 UI 块数一致 | Agent 调 get_artifact_diff 能正确说出改了几块，与 UI 块数一致 | E2E `C6-①`：get_artifact_diff(v3,v4)（v4 物化后）与 Web presentation 块数/kind 序列一致（5 块 mod/add/del/mod/mod）——PASS；T1-10 引用：diff 块全收重建 = 新版本精确相等 |
| AC-1.3 工具集物理无 write/edit | doc 模式工具集中不存在 write/edit；写入只能经 propose_edit | S5 冒烟：CLI 启动 `--tools` 六工具白名单（物理无 write/edit/bash）+ smoke-probe.ts `assembly.ready`（tools 六工具 + excludeTools）——PASS；T1-10 verifier：真会话能力层白名单双断言同过 |
| AC-1.4 只读零副作用 | 三只读工具不产生 PendingChange | T1-10 verifier：三只读工具全链路各调一次后 versions/*.json 逐 byte 不变、物化 .md 不变、pending 目录零文件、审计计数不变（比实现者断言更严）——本卡 E2E 审计计数佐证：CLI 读操作不产生审计条目（E5-⑭ cli=2 恰为 propose + approval_request 两条写路径条目） |

### 1.2 F1 纯 CLI 端到端成立（正本 F1：一切落盘产物改动必经「提案 → 逐块确认 → 新版本」）

- **真模型全链（S5 冒烟）**：`create_artifact` 建文档 v1 → `propose_edit` 提议 → CLI 汇总卡（已决 0/1）→ tmux 真实按键 y1 → a → Enter →「已确认并物化为 v2」。领域终态：versions/1.json + 2.json（v2 note=apply pending、author=user）、物化文件 = 修改后全文、pending 目录零文件——**纯 CLI 全链成立**。
- **跨通道 F1（E2E E5）**：CLI 侧 `propose_edit`（deferred 落盘）→ Web 面板裁决全收 → 物化 v5（`E5-⑥~⑧`）——提案 → 确认 → 新版本链路在 CLI/Web 双通道交错下保持成立。
- **CLI 键盘全收语义（E2E C6-②）**：CLI 侧 materialize（resolved 全收）→「已确认并物化为 v5」+ 审计 `approval_response(via: cli-keyboard)`。
- **BASE_VERSION_CONFLICT 防线（E2E E5-②~⑤）**：基底过期时写回被拒（UI 人话横幅 + API 409 BASE_VERSION_CONFLICT）、pending 保留现场、discard 出口可走通——F1 的版本一致性不因双通道竞争破功。
- T1-10 已首次真实验证（verifier 复跑 tui-smoke.sh + 取消分支真 TUI）。

### 1.3 EXTERNAL_MODIFIED 保护实测有效（S4 全场景，12 条断言全 PASS）

- **检测**：绕过系统直写物化文件 → 面板警告横幅（EXTERNAL_MODIFIED + 文件名）+ 磁盘现状预览摘录（S4-①/②）。
- **冻结**：警告消除前写回禁用 + 回滚按钮禁用（title 含「外部手改待处理」）（S4-③a/③b）。
- **三动作不静默**：查看 diff（差异明细含外部行 ins）；拒绝采纳 → 磁盘恢复系统版逐字节且版本号不变（不生成幽灵版本，H4）+ 审计 `artifact_external_resolved(action=reject)`；以提案方式合并 → 转提案（sourceActor=external-merge、卡片带来源标识）+ 审计 `action=merge`，合并写回物化 v5 = 外部全文（不静默丢弃）（S4-④/⑥a/⑥b/⑥c/⑦/⑧/⑨/⑩）。
- **merge 守卫**：既有 pending 时合并被拦截（pending 未变、磁盘外部内容保留、modified 仍 true）（S4-⑤）。

### 1.4 presentation 纯数据 + 通用渲染器承重实证 + 双端一致（通道①）

**结构证据（承重结构成立）**：
- 渲染器纯函数：`renderer.ts`/`panel-state.ts`/`types.ts` 零 `document`/`window`/`HTMLElement` 引用（T1-12 verifier 独立复扫），输出 RenderNode 纯数据树；DOM 只在 `dom.ts`/`panel.ts`（壳层）——「新增条目类型两壳零改动」的 Web 侧承重结构（T1-12-verify.md §二）。
- presentation 构建在 L1（`domain/presentation/builders.ts` 纯函数，零 pi import、零 IO），L2/L3 只消费——「壳零领域判断」红线由 T1-11/12 复核。

**行为证据（承重实证走真浏览器）**：S1–S4 全场景真浏览器 E2E（本卡，断言总数见 §四），含物化文件级断言（v4 = v3 + 被收块、被拒块不进，逐字节）与审计文件级断言（approval_response 逐块明细 + artifact_resolved 计数，append-only）。

**双端一致（通道①：CLI 工具读数 vs Web API 返回逐字段，同一 fixture 目录）**：

| 断言 | 内容 | 结果 |
|---|---|---|
| C6-⑤ | CLI list_artifacts vs Web API artifacts：id/title/kind/currentVersion 逐字段 | PASS |
| C6-⑥ / E5-⑪ | CLI get_artifact_history vs Web API versions：version/author/createdAt/note 全版本逐字段 | PASS |
| E5-⑫/⑫b | CLI get_artifact_diff vs Web presentation diffRef 块：kind/lines/oldLines 逐块逐字段 + 锚点一致（CLI 块标题行 label = Web anchor） | PASS |
| C6-③ | CLI 侧物化 → Web 面板重载显示同一版本（badge 已确认 v5 + 正文含 CLI 物化段落） | PASS |
| C6-④ | Web API 版本链含 CLI 物化版（v1–v5，v5 note=apply pending） | PASS |

**P2-3 覆盖论证（CLI→Web 方向无直接 E2E 的场景）**：写路径语义由 T1-10 单测 + verifier 独立驱动覆盖（propose_edit 全链、物化重建不变量）；读路径共享 fixture 由本卡 C6/E5 双端逐字段断言覆盖——两方向合拢，无裸露通道。

**P2-1 轻量审计断言（E5-⑧~⑩/⑭）**：CLI 条目（artifact_proposed/approval_request）与 Web 条目（approval_response/artifact_resolved）各自文件内完整（ns/ts/kind/artifactId 必备字段遍历），同一 changeId 在两文件成对出现；跨文件排序合并显式推迟第三期（不承诺）。

---

## 二、正本 §11 自检清单可执行项对号

§11 启动指令硬性要求中本期可执行项（全对号）：

| 可执行项 | 状态 | 证据 |
|---|---|---|
| 本轮只做 M1 M2 M3 M4 M6，M5 只留接口 | ✅ | round-1 范围卡（PRD §0 与任务卡）；M5 自动沉淀冻结（D3） |
| 分期固定，禁止跳期 | ✅ | 本卡为第一期最后一张；第四期才做的通用渲染器完善/双前端快照回归未提前实现（第一期仅 presentation 承重实证，正本 §10 明确本期即做） |
| 不得引入数据库 / 多用户 / 云端 | ✅ | L1 纯文件 JSONL 领域存储；server 零运行时依赖、单进程单 writer（T1-11 verify §二 架构裁定） |
| 不得引入组件库 | ✅ | 前端零框架原生 JS（T1-12 裁量①：零 react 依赖、esbuild 直打包） |
| 不得让 AI 在无人确认时写入任何落盘产物（F1） | ✅ | 全部写路径经「提案 → 确认 → 新版本」：面板写回 approval_response、CLI 汇总卡逐键确认、外部合并转提案；无人确认的直写被 EXTERNAL_MODIFIED 检测（§1.3） |
| 领域逻辑不得写进前端 | ✅ | 渲染器零领域判断（§1.4 结构证据）；前端零 `@pgoone` import、零 `node:` 内置（T1-12 verify §二 红线复核） |
| 闸门不得直接调终端交互 API | ✅ | CliDecisionPort 经 ctx.ui（T1-08 spike：execute 内 ctx.ui 能力实证，TUI/RPC 双通道） |

---

## 三、S 场景覆盖对号表（PRD 场景剧本）

| 场景 | 承载 | 断言数 | 结果 |
|---|---|---|---|
| S1 主路径逐块混合确认 | E2E `s1MixedDecisions` | 23 | 全 PASS（含物化文件级 8 条 + 审计级 3 条） |
| S2 批量档 + 批量后单块翻转 | E2E `s2Bulk`（S2a 4 + S2b 6） | 10 | 全 PASS（S2a-③ v4 = 提案全文逐字节） |
| S3 版本链与回滚（方案 C） | E2E `s3HistoryRollback` | 12 | 全 PASS（回滚报告「确认过 3 块」= P1-4 审计回放取数非巧合；撤销回滚 v6 = v4 内容逐字节） |
| S4 外部手改检测 | E2E `s4ExternalModified` | 13 | 全 PASS（§1.3 明细） |
| S5 CLI 侧主路径 | `cli-smoke.sh`（真模型 + tmux 全链，可重复）+ E2E E5/C6 通道①交叉 | 冒烟断言 6 组 + E2E 交叉 19 | 冒烟见 §四；E2E 全 PASS |
| 异常分支 BASE_VERSION_CONFLICT | E2E `e5ConflictLoop` | 17 | 全 PASS |
| 通道① CLI→Web | E2E `c6CliToWeb` | 10 | 全 PASS |

---

## 四、门禁与 E2E 数字

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（根 workspace：pi + web） | 0 错 |
| `npm test`（根） | **Test Files 20 passed / Tests 284 passed** —— 基线 284 零回归 |
| `npm run e2e`（apps/web，含 build + 薄 server + 共享 fixture + 真浏览器驱动） | **85 断言 0 失败**（S1 23 / S2a+S2b 10 / S3 12 / S4 13 / E5 17 / C6 10 + 主流程无异常），可重复执行 |
| `bash e2e/cli-smoke.sh`（S5 真机冒烟） | **EXIT=0 全通**：真模型 + tmux 全链（create → 只读三工具 → propose → 汇总卡 y1/a/Enter → 物化 v2）；probe.log 五条 tool.call 留痕；领域目录 v1+v2（v2 note=apply pending、author=user）、pending 零文件；Web server 同目录三段断言全 PASS（smoke 项目 → 冒烟文档 → currentVersion=2），Web API detail 版本链/内容/审计与 CLI 冒烟逐项一致（S5 期望③唯一真相）；锁释放正常，可重复执行 |

E2E 可重复性：`run-e2e.sh` 每次 `mktemp` 独立数据目录 + fixture 种子幂等重建（demo 项目删除重建）+ 场景间审计文件清零——修复期间连跑 4 遍，断言数 74→85 逐轮收敛后稳定全绿（可重复执行实证）。

---

## 五、登记项（P3 注记 / 已知瑕疵）

- **merge 拦截时面板误报**：S4-⑤ 以提案方式合并被既有 pending 拦截时，面板误报「已转为提案」并清除 extMode（前端消费 pending_exists 的已知瑕疵，驱动内注释登记）；数据层不动（pending 未变、磁盘外部内容保留）。verifier 复核时可按 E2E S4-⑤ 断言行为复现。
- **回滚灰化块跨会话丢失**：T1-12 P1-b 已登记（rolledback 纯内存态，刷新后灰化块与回滚报告横幅丢失），本卡 S3 走同会话窄路径（写回后立即回滚），断言按该路径设计。
- **物化版本 author=user**：旧仓语义（正本 P3 注记），list_my_artifacts「名下」过滤因此只命中 create_artifact 建版；E2E C6-⑦ 按此语义设计（CLI create 建归属前提后再断言）。
- **E2E 驱动断言的 schema 适配**：CLI get_artifact_diff 块（lineStart/lineEnd）与 Web presentation 块（anchor）表示不同，双端一致断言按可比字段（kind/lines/oldLines + 标题锚）比对，不伪造不存在的字段。

---

## 六、自评结论

四条出口判据逐条 PASS；S1–S5 场景全覆盖（真浏览器 E2E 85 断言 + 真机冒烟 EXIT=0）；门禁双跑零回归（typecheck 0 错、284/284）；E2E 与 S5 冒烟均可重复执行（修复期连跑实证）。verifier 双层验收人工清单（六工具可调、无 write/edit、受管路径直写被硬挡）中的后两项由 T1-10 独立验证记录引用，真模型链路按 cli-smoke.sh 复跑。

**STATUS: PASS（实现侧自评）—— 一阶段出口判据四项全绿，待 verifier 复核**
