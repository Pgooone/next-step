# T1-13 验收复核（verifier · 一阶段出口终审）

- **卡**：T1-13 · Web E2E + 出口判据收官（round-1 最后一张，一期实现收官）
- **实现**：impl-t1-13b（haiku 档）；视觉层已由 lead 经智谱识图 MCP 核验通过（回滚态/手改警告态四点 PASS），本报告覆盖逻辑层 + **正本 §10 第一期出口判据终审**
- **verifier**：verifier（opus）｜2026-08-18｜全部证据独立复跑，不采信报告转述
- **结论**：**PASS** —— 一阶段出口判据四项全绿（独立复证），§11 七项对号（机械 grep 核实），门禁双跑零回归；P2×1 + P3×5 登记留档，无阻塞项

---

## 一、E2E 独立复跑 + 断言质量抽查

### 1.1 全量复跑

`bash apps/web/e2e/run-e2e.sh` 独立复跑：**总断言 85，失败 0，EXIT=0**（独立 `mktemp` 数据目录 + fixture 种子幂等重建）。断言分布 S1 23 / S2a+S2b 10 / S3 12 / S4 13 / E5 17 / C6 10 = 85，与 exit-report §四一致。

### 1.2 断言判别力抽查（抽 10 条读源码验证）

| 断言 | 期望形态 | 判别力评估 |
| --- | --- | --- |
| S1-①a 初始 5 块 pending | `blocks.length===5 && every(state==="pending")`（DOM dataset） | 真实：块数+状态双卡 |
| S1-④a 写回横幅 | 「接受 3 块 → 物化为 v4」+「拒绝 2 块」 | 真实：数字与点击序列 ✓✓✗✓✗ 绑定 |
| S1-④d/e 物化 v4 | mustContain 6 条 + mustAbsent 1 条（正反两面） | 真实：被拒 del 块保留（含 §4）+被拒 mod 块新文案不出现 |
| S1-⑤b 审计 decisions | 5 条、accept 3/reject 2、via=web-panel | 真实：逐块明细与点击对账 |
| S2a-③ 物化 = 提案全文 | `mat === V4`（严格逐字节相等） | 最强形态，经篡改实验验证（见 1.3） |
| S3-⑤a 撤销回滚 | `mat === s1MatSnapshot`（**跨场景**逐字节） | 设计出色：S3 独立重跑同裁决序列，v6 必须逐字节复原 S1 的 v4 |
| S3-④a 回滚报告 | 「撤销 5 块」+「确认过 3 块」 | 真实：3 来自审计回放（3 收 2 拒非巧合），若抄撤销块数 5 即红 |
| S4-⑥a 拒绝采纳 | `restored === v3Content`（逐字节） | 真实：磁盘恢复系统版 |
| E5-②b 冲突 API | `status===409 && error==="BASE_VERSION_CONFLICT"` | 真实：错误码=前端人话文案的真相源 |
| C6-⑤/E5-⑪ 通道① | 逐字段 id/title/kind/currentVersion + version/author/createdAt/note | 真实：CLI 工具读数 vs Web API 逐字段（detail 实测 cli=5 web=5） |

### 1.3 篡改实验（防恒真断言，三段闭环）

篡改 S2a-③ 期望 `mat === V4` → `mat === V4 + "\n"` 后复跑：**恰该 1 条 FAIL（85 断言 1 失败，EXIT=1）**，其余 84 条不受牵连；恢复后复跑 **85/0 全绿**。多一个换行即红——严格逐字节断言真有判别力，未发现恒真断言。

### 1.4 断言强度弱点（P3，不阻塞）

- **E5-⑭ 为 `>=2` 下限断言**（非恰等）：exit-report §1.1 转述「cli=2 恰为两条写路径条目」读作恰等，实际恰等是 detail 实测值（本次复跑 detail=`web=5 cli=2`，「只读工具零审计条目」事实成立）。AC-1.4 主证据是 T1-10 verifier 逐 byte 验证，不受影响。
- **E5-⑫b 锚点一致含 `h === null ||` 跳过分支**：无标题行的不比对（schema 宽容）；E5 场景单块（add §2.4 含标题）实际校验 1 块，覆盖面窄但方向正确。

## 二、S5 真机冒烟独立复跑（真模型 + tmux）

`bash apps/web/e2e/cli-smoke.sh`：**SMOKE_EXIT=0**，证据逐项核对：

- **probe.log 恰 5 条 tool.call**（真模型真实调用）：create_artifact（kind=design title=冒烟文档）→ get_artifact_history → list_my_artifacts → get_artifact_diff → propose_edit（newContent=修改后全文）——顺序与指令一致。
- **AC-1.3 双证**：CLI 启动 `--tools` 六工具白名单 + assembly.ready 记录 `whitelist=[六工具+read/grep/glob/list]`、`excludeTools=[write,edit,bash]`。
- **汇总卡逐键链**（smoke.pane 帧）：「已决 0/1 块」→ y1 →「已决 1/1 块」→ a → Enter →「已确认并物化为 v2」。
- **领域终态**：versions/1.json+2.json（v2 `author=user`、`note="apply pending <changeId>"`）、物化文件=「## 需求\n修改后的需求段落。」全文、pending 目录零文件。
- **Web 同数据目录三段全过**（S5 期望③唯一真相）：smoke 项目 → 冒烟文档 → `currentVersion=2`。
- 脚本弱点（P3）：tmux `wait_for` 物化等待失败只截图不 exit 1（EXIT=0 不自证全链）——本次以 pane/probe/领域目录内容核对补全，全链实证通过。

## 三、一阶段出口判据终审（正本 §10 第一期）

### 3.1 四条判据逐条独立验证

| 判据 | 独立验证 | 结论 |
| --- | --- | --- |
| AC-1.1~1.4 全绿 | ① 本卡 E2E 断言名逐条在复跑日志确认真跑过：C6-⑤/⑥/⑥b/⑦、E5-⑪~⑬（AC-1.1）；C6-①（AC-1.2，diff 块数+kind 序列与 UI 一致）；E5-⑭ 佐证（AC-1.4）。② 冒烟 probe.log 五条 tool.call（AC-1.1 真模型）+ assembly.ready/--tools（AC-1.3）。③ **T1-10 verify 引用逐条核对属实**（qa/T1-10-verify.md：13/13 独立驱动、AC-1.4 逐 byte Buffer.equals、白名单双断言、结构化 JSON 回灌 LLM 上下文直查） | **PASS** |
| F1 纯 CLI 端到端成立 | 真模型全链（§二：create→propose→汇总卡逐键→物化 v2）+ E5 CLI 提案→Web 裁决→v5 + C6-② CLI 键盘全收（via=cli-keyboard 审计）+ E5-②~⑤ BASE_VERSION_CONFLICT 防线（409+pending 保留+discard 出口）——全部断言复跑 PASS | **PASS** |
| EXTERNAL_MODIFIED 实测有效 | S4 13 条断言全 PASS（检测①②/冻结③a③b/查看 diff④/拒绝采纳⑥a⑥b⑥c 逐字节+无幽灵版本/merge 转提案⑦⑧⑨/守卫⑤/不静默丢弃⑩ 逐字节） | **PASS** |
| presentation 承重实证 | 结构证据独立复扫：渲染器三文件零 `document/window/HTMLElement`、builders 零 pi import 零 IO、web/ 运行时零 `@pgoone`/零 `node:`（且有自检测试）+ 行为证据 S1–S4 真浏览器 85 断言 + 通道①双端逐字段（C6/E5） | **PASS** |

### 3.2 正本 §11 自检清单七项对号（机械项独立 grep）

| 可执行项 | 独立核实 |
| --- | --- |
| 只做 M1 M2 M3 M4 M6，M5 只留接口 | grep `autoSediment/自动沉淀/SkillStore` 全仓零命中 ✓ |
| 分期固定禁止跳期（含不越期提前） | trace_defect 零实现（source-refs.ts 仅 M2a「只写不查」+ 第三期消费注记）、编排/submit_plan 零命中、双前端快照回归零测试文件 ✓ |
| 不引入数据库/多用户/云端 | 存储纯文件 JSONL；server 运行时零依赖（package.json 全 devDeps）；无 auth ✓ |
| 不引入组件库 | 前端零框架原生 JS，无 react/vue 依赖 ✓ |
| AI 无人确认不写任何落盘产物 | 全部写路径经「提案→确认→新版本」；server 十端点无 AI 直写端点（写类仅 resolve/rollback/external 三动作，均用户触发）✓ |
| 领域逻辑不写进前端 | 见 3.1 第四行 ✓ |
| 闸门不直接调终端交互 API | pending-gate-service.ts/ports.ts 零 `ctx.ui/stdin/readline/console` ✓ |

### 3.3 登记项裁决：merge 拦截误报——**P2 维持（二期修），不阻塞收官**

根因链（verifier 读码确认）：L1 `mergeExternalAsProposal`（external-modification-service.ts:120-128）既有 pending 时**返回** `{status:"pending_exists"}`（不 throw，数据层正确防线）→ server 端点 200 透传 → 前端 `externalAction`（panel.ts:654-673）**不检查返回 status**，无条件报「外部手改已转为提案」并清除 extMode。

裁决理由：
- 数据层零伤：S4-⑤ 断言已锁死行为契约（pending 未变、磁盘外部内容保留、modified=true），复跑 PASS；
- 出口判据不破：四条判据均不涉此反馈文案；EXTERNAL_MODIFIED 判据要求「三动作不静默」，reject/merge 真实语义有数据层逐字节断言；
- 自愈路径存在：重开面板警告横幅恢复（E2E S4-⑤ 场景内实测走通）；
- 但**不是 P3**：这是「系统说成功但实际没做」的方向性反馈失真，比 T1-12 登记的纯展示态丢失（刷新丢灰化块）语义更重，建议二期优先排（前端约 10 行：检查 status 分支 + 保持 extMode + 更新 E2E 断言）。

## 四、红线与收官检查

- `npm test`：**Test Files 20 / Tests 284**，284 基线零回归 ✓
- `npm run typecheck`：0 错 ✓
- key 零泄漏：`apps/web/e2e/` grep `sk-` 零命中；smoke.pane / probe.log / web-read.log 零 key 值（key 仅从 `.env.pi-test` 读入进程环境）✓
- 工作区改动范围：`.gitignore`(+dist-web/)、`apps/web/package.json`(+e2e script、+playwright-core devDep)、package-lock、`styles.css`(lead 2px 视觉修正)——均在 T1-13 边界内 ✓
- E2E 可重复性：本次三跑实证（首跑 85/0 → 篡改 84+1F → 恢复 85/0），每次独立 mktemp 目录、fixture 幂等重建

## 五、分级汇总

| 级别 | 项 | 处置 |
| --- | --- | --- |
| P2 | merge 拦截时面板误报「已转为提案」（前端不查 pending_exists 返回） | 二期修，建议优先（§3.3 裁决） |
| P3 | exit-report §1.3 标题「12 条断言」实为 13（§三表自记 13 正确）；§三表 S1「物化文件级 8 条」实为 7（④d×6+④e×1，口径含糊） | 报告计数勘误，随手改 |
| P3 | E5-⑭ 下限断言被转述为恰等语义（§1.4） | 留档；AC-1.4 主证据不受影响 |
| P3 | cli-smoke.sh 物化等待失败只截图不 exit 1（EXIT 语义弱） | 二期顺手补 `exit 1` |
| P3 | smoke-probe.ts 硬编码仓库绝对路径（可移植性） | 二期顺手参数化 |

（既有登记不重复列：回滚灰化跨会话丢失 = T1-12 P1-b；物化 author=user = 旧仓语义正本 P3 注记；E2E schema 适配 = README 已明示。）

## 六、haiku 质量评价

实现（haiku 续做）质量高：断言体系有真判别力（严格逐字节、正反两面、跨场景一致性、防巧合数值四类设计齐备），fixture 单一来源同源注入（种子与断言共用 fixture-content.mjs），报告登记诚实——merge 误报、author 语义、schema 差异全部主动登记且经读码核实与代码事实相符，无掩饰。短板为报告两处计数小误差与一处断言强度转述偏乐观（§1.4/P3），不影响证据链成立。

## 七、一阶段出口终审结论

正本 §10 第一期出口四条判据（AC-1.1~1.4 / F1 纯 CLI / EXTERNAL_MODIFIED / presentation 承重）**全部独立复证 PASS**；§11 七项硬性要求全对号；门禁双跑零回归（typecheck 0 错 + 284/284）；E2E 与真机冒烟均可重复执行且本次独立复跑全绿。P2×1 + P3×5 均已登记留档、无一触碰判据。**第一期（round-1）实现收官成立，可交付双层验收收口。**

STATUS: PASS —— E2E 独立复跑 85/0 + 篡改验红恢复闭环；S5 真机冒烟 EXIT=0 且五条 tool.call/领域终态/Web 三段逐项核对；一阶段出口判据四项全绿（T1-10 引用逐条属实、§11 七项机械 grep 核实）；门禁 284/284 + typecheck 0 错、零 key 泄漏、改动不越界；merge 误报裁决 P2 二期修不阻塞，P3×5 留档
