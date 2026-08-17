# T1-08 Spike 复核报告（独立验收）

> 验收人：verifier（opus，2026-08-18）
> 对象：`docs/rounds/round-1/qa/T1-08-spike-report.md`（实现者 haiku）+ 证据 `/tmp/t1-08-spike/`
> 方法：逐份证据与报告结论对表 + pi 源码佐证逐处核验 + 关键实验独立复跑 4 个（自写脚本于 `/tmp/t1-08-verify/`，不进仓库）
> 环境：pi 0.84.2（node_modules 精确 pin）、真模型 deepseek-v4-flash（key 从 `.env.pi-test` 进程注入，未落任何文件）、tmux

## 一、证据审计明细（报告声称 ↔ 证据可指认行）

| # | 报告声称 | 证据落点 | 对表 |
|---|---|---|---|
| 1 | Q1 RPC select 全链路 | `rpc-q1_select.log` UI REQ（id 98f85d16 与报告引用一致）→ UI RES beta → tool_execution_end；`probe.log` L1-2 `hasUI/ctxSignal/execSignal` 三真 | ✓ |
| 2 | Q1 TUI 选择器真渲染 | `tui-select.pane` L89-95：`→ alpha` 高亮 + `escape/ctrl+c cancel` 帮助行 | ✓ |
| 3 | Q2 RPC 循环 select 三轮逐个 | `rpc-q2_loop.log` 三个 UI REQ/RES 逐个；`probe.log` L5-6 `loopRounds:[driver-round-1..3]` | ✓ |
| 4 | Q2 custom TUI 决策数组回传 | `probe.log` L24 `{"custom":{"blocks":["accepted","accepted","rejected"]}}`；`tui-custom.pane` L80-87 初始渲染帧（overlay 卡片+帮助行+Working 状态） | ✓（初始帧；中间帧缺失，见 P2-1） |
| 5 | Q2 custom RPC 返回 undefined | `rpc-q2_custom_rpc.log` 无任何 UI REQ 直接 tool_execution_end；`probe.log` L14-15 `result:{} elapsedMs:0`；`rpc-mode.js` L152-154 源码 | ✓ |
| 6 | Q3 RPC cancelled 响应 | `rpc-q3_cancel_select.log` L11 `{"cancelled":true}` → `probe.log` L11-12 `result:{}` | ✓ |
| 7 | Q3 对照实验（传/不传 opts.signal） | `rpc-q3_abort_mid.log` abort → tool_execution_end → agent_settled；`rpc-q3_abort_noopts.log` abort 后 8s 无返回；`probe.log` L11-12（有 result）vs L13（enter 无 result = 挂起实锤） | ✓ |
| 8 | Q4 RPC 逐块 confirm | `rpc-q4_confirm_seq.log` 三 confirm 交替 false/true/false → `probe.log` L8 `confirmSeq:[false,true,false]` | ✓ |
| 9 | Q4 TUI confirm 序列 | `probe.log` L31 `confirmSeq:[true,false,true]`（无逐键帧，但值只能由真实按键产生——RPC 模式无 driver 回灌） | ✓ |
| 10 | 源码佐证 7 处 | `runner.js` createContext `get ui(){return runner.uiContext}`；`rpc-mode.js` createDialogPromise 仅在 `opts?.signal` 挂 abort 监听（abort→resolve(defaultValue)）；`interactive-mode.js` showExtensionSelector 同样仅 `opts?.signal`；`agent-loop.js` L453-455 run signal 直传 execute 第三参；`agent.js` abort() 触发 abortController；`types.d.ts` L372 execute ctx 为完整 ExtensionContext | ✓ 全核 |
| 11 | 环境坑（tmux 变量内联 / 模型空名 TypeError） | `tui-diag.log` 有完整栈 | ✓ |

对照实验方法审计（防「测的是别的」）：`probe-extension.ts` L77 `dlgOpts = params.abortOpts && signal ? {signal} : undefined`——自变量唯一（对话框是否传 signal）；`driver.mjs` L149-158 两分支 driver 行为逐字一致（都不回 UI response、都发 abort 命令），差异仅在工具侧参数。对照干净。✓

## 二、独立复跑记录（verifier 自写，`/tmp/t1-08-verify/`）

| 复跑 | 设计 | 结果 |
|---|---|---|
| R1 · Q3 mid | 同原实验（select 传 opts.signal + RPC abort） | **复现**：abort → tool_execution_end → agent_settled（`rpc-v2_mid.log`） |
| R2 · Q3 noopts + signal 探针（原实验未测的机理） | select 不传 opts，同时监听 execute 第三参 signal 与 ctx.signal | **复现挂起**（8s 窗口 settled=false，execute.result 永不出现）且 **机理钉死**：`signal.aborted` 双双在 abort 后 1ms 触发（`probe-v2.log`：`{"source":"exec-third-arg","at":1}`、`{"source":"ctx.signal","at":1}`）——**signal 确实到达 execute，对话框因未接 opts.signal 而不 resolve**。报告「对话框不自动订阅」结论成立且更精确 |
| R3 · Q2 custom TUI 逐键（补原证据缺的中间帧） | tmux 逐键 1/a/3/Enter，每键后 capture | **完整复现**：`custom.key` 序列 `1→[accepted,pending,pending]`、`a→[accepted,accepted,accepted]`、`3→[accepted,accepted,rejected]`、submit；pane 帧 T2-T4 逐键状态**即时上屏**（每键后 capture 可见翻转），T5 Enter 后卡片消失；`execute.result` 决策数组与原实验一致（`tui-custom-keys.pane` + `probe-v2.log`） |
| R4/R5 · 取消键判别（Esc vs q） | 同一轮先 Esc 再 q；R5 加 raw key 日志 | **发现反证**：Esc 后卡片仍在（V2/W2 帧 PENDING、Working...）、无 custom.cancel；q 后卡片消失、`custom.cancel` + `execute.result:{}`。R5 钉死编码：**Esc 的 handleInput data 是 `""` 而非 `""`**——原 probe-extension 的 `data === ""` 分支永不匹配，Esc 关不掉 custom 卡片；q 路径成立（`tui-custom-cancel.pane` / `tui-custom-rawkey` / `probe-v2.log`） |

## 三、Findings 分级

### P1（不推翻形态裁决，但 T1-09 实现必须修正，否则取消分支带病落地）

1. **custom 的 opts 不接受 signal**。`types.d.ts`：custom options 仅 `{overlay?, overlayOptions?, onHandle?}`（signal/timeout 是 select/confirm/input 的 `ExtensionUIDialogOptions` 专属）；`showExtensionCustom`（interactive-mode.js L2124-）实现中无任何 abort 接线。报告边界②「取消可感知需显式传 opts.signal」与草案要点 1「所有对话框一律传 {signal}」只对内置对话框成立——草案代码 `{ overlay: true, ...dlgOpts }` 传了也无效（TS 亦报多余属性）。报告已自标「实现时核验」，本次核出结果：**custom 汇总卡的 agent-abort 接线必须在组件 factory 闭包内自建**——把 execute 第三参 signal 捕获进 factory，`signal.addEventListener("abort", () => done(undefined))`，组件 dispose 时移除监听。
2. **custom 组件取消键的 Esc 归因错误**。原报告 4.1「custom 组件 Esc → done(undefined) → execute 完成」：复跑三轮反证（Esc 后卡片不关），根因是 Esc data=`""` 而组件判断 `data === ""`。原 probe.log L27 的 `result:{}`（1277ms）只能证明「某键取消了」，留存证据无法指认是 Esc——按 q 路径代码必然工作推断，当时按的应是 q。报告边界③「对话框内 Esc/Ctrl+C 被消费为用户取消」对**内置**对话框成立（`tui.select.cancel` 默认键 `["escape","ctrl+c"]`，pi-tui keybindings.js L86-88，框架保证），对 **custom 组件不成立**。T1-09 汇总卡取消键三选一：匹配 `""`、走 keybindings 抽象层（`kb.matches(data, ...)`）、或主打 `q`（实测可用）。

### P2（报告表述与证据留存不符，结论本身有旁证/复跑支撑）

3. **「TUI 逐键留证」名不副实**。`tui-run.sh` 只 capture 到「交互元素出现」（4 帧），无任何按键驱动与后续 capture 代码；`tui-custom.pane` 仅初始 PENDING 两帧，`tui-select.pane` 仅 select 帧，loop 仅 round 1 帧。报告 §一「每步 capture-pane 落 tui-*.pane」与 §3.2「TUI 逐键留证」超出留存；「即时上屏无闪烁」当时无帧可证。R3 复跑已补齐逐键帧且结论恰好成立，故记表述问题而非结论错误。
4. **driver 判定行打印无意义值**。`rpc-q3_abort_noopts.log` L12「dialog still pending=false (noopts case: pending expected)」中 `pending=${!!child.killed}` 恒 false（child 未 kill），措辞自相矛盾；实际判定依据（tool_execution_end 缺席 + probe.log execute.result 缺席）成立。

### P3（备注）

5. `abort_probe` mode 在 probe-extension.ts 声明但从未运行（probe.log 无记录）；报告未声称它，无虚报。「signal 是否到达 execute」当时未测，R2 已补（到达）。
6. 多处 log 为两次跑叠加（rpc-q1_select.log 两段、probe.log L9-10/L11-12 两次 abort_mid）；报告只述一次，无碍。
7. rpc log 尾部 GLOBAL TIMEOUT 90s + exit 143：driver 未在 settled 后主动收尾，无碍证据。

## 四、四问判定与形态建议审计

- **Q1 PASS**：成立。双通道 + 源码 + 复跑三重支撑。
- **Q2 PASS**：成立且被 R3 强化（逐键上屏帧补齐，决策数组完整回传复现一致）。形态 A（custom 汇总卡）依据扎实。
- **Q3 PASS（有前提）**：成立且被 R2 强化（signal 到达 execute、对话框不订阅的机理钉死）；但「前提」适用范围须修正——opts.signal 接线只覆盖内置对话框，custom 需组件内自接（P1-1）。
- **Q4 PASS**：成立（双模式值证据）。
- **形态建议（A 为主 + B 保底）**：自洽。A 载体全链路（渲染/翻转/提交/取消/数组回传）复现成立；B 保留为 RPC 形态与退化兜底合理。三条边界：① custom 仅 TUI ✓；② signal 必传 ✓ 但须补「custom 例外」（P1-1）；③ Esc 语义须修正（P1-2）。
- 新发现四条：第 1/2/3/5 条全部核验成立；第 4 条前半（全局键位 escape interrupt / ctrl+c clear）成立，后半推论（对话框内 Esc 对 custom 成立）被复跑推翻。

## 五、对 T1-09 的修正建议（供卡内吸收）

1. CliDecisionPort.ask 的 custom 分支：对话框 opts 不传 signal（传也无效）；改为 factory 闭包捕获 execute signal 自接 abort → `done(undefined)`，并在组件完成/取消时移除监听（防泄漏）。
2. 汇总卡组件取消键：匹配 `data === ""`（Esc 实测编码）+ `q` 双路径；不要用空字符串判断。
3. 取消来源区分维持报告结论：返回 undefined = 用户取消（q/Esc）；signal.aborted = agent 中断——两者在 custom 分支同样可区分（自接监听先于 done(undefined) 检查 signal.aborted）。
4. 内置对话框（保底 B 的 confirm/select 循环）维持报告原案：一律传 `{signal: ctx.signal}`。

## 六、spike 质量评价

haiku 的 spike 在实验设计上超预期：双通道互证、对照实验自变量控制干净、源码行号级佐证全部真实可查、四个关键结论全部经独立复跑成立——但留证纪律与结论边界有欠：TUI「逐键留证」实际未留帧（表述超前于证据），且两处 P1（custom 无 opts.signal、Esc 编码）恰好落在「形态 A + 取消分支」的交汇点上未钉死，需本复核补验后才可安全进入 T1-09。

---

STATUS: PASS —— 四问结论与形态裁决（A 汇总卡为主 + B 保底）经证据审计、源码核验与 4 项独立复跑全部成立（含 Q3 signal 机理增强钉死：signal 到达 execute 而对话框不订阅）；但附 2 条 P1 修正必须在 T1-09 落地：① custom 的 opts 不接受 signal，汇总卡 abort 接线须组件 factory 内自建（监听 execute signal → done(undefined)）；② custom 组件内 Esc 的 handleInput data 实测为 "" 而非 ""，原「Esc 关卡」路径不成立，取消键须按 ""/q 实现或走 keybindings 抽象层（内置对话框不受影响，tui.select.cancel=["escape","ctrl+c"] 框架保证）。另 P2 两条（逐键留证表述超前、driver 判定行措辞）记录在案，不阻断。
