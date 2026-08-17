# T1-08 Spike 报告 · CLI 汇总卡交互（execute 内 ctx.ui 能力边界实证）

> spike 执行人：round-1 实现队员（2026-08-18）
> 卡片：`docs/rounds/round-1/tasks/T1-08-SPIKE-CLI汇总卡交互.md`（产出路径按 lead 指示落本文件）
> 环境：pi 0.84.2（node_modules 精确 pin）+ 真模型 deepseek-v4-flash（key 取自仓库根 `.env.pi-test`，仅注入进程环境，未进任何代码/日志/报告）
> 实验代码（可丢弃，不进 src/）：`/tmp/t1-08-spike/{probe-extension.ts, driver.mjs, tui-run.sh}`；证据：`probe.log`（execute 事件）、`rpc-*.log`（RPC 事件流）、`tui-*.pane`（TUI capture-pane）

## 零、结论速览

| 问 | 内容 | 判定 | 一句话 |
|---|---|---|---|
| Q1 | execute 内 ctx.ui 可用性 | **PASS** | select/confirm/input 双模式（RPC/TUI）全通，ctx.signal 与 execute 信号参数俱在 |
| Q2 | 多轮状态交互（汇总卡） | **PASS** | 循环 select 多轮可用；**ctx.ui.custom() 可渲染真汇总卡**（状态即时上屏、快捷键翻转、提交返回决策数组）；custom 仅 TUI |
| Q3 | 取消可感知 | **PASS（有前提）** | 对话框内 Esc/Ctrl+C 与 RPC cancelled 均可达 execute（返回 undefined/false）；agent abort 注入必须**显式把 execute signal 传入对话框 opts.signal**，否则对话框不关、execute 挂起 |
| Q4 | D6 保底（逐块 confirm 序列） | **PASS** | 双模式逐块确认产出等价决策数组，退化不丢 F1 |

**形态裁决：选 A（汇总卡，custom 组件实现）+ 逐块翻转用组件内部状态机；D6 B 保底路径保留为 TUI 退化兜底与 RPC 模式实现形态。**

---

## 一、实验方法（双通道互证）

1. **RPC 全自动通道**（`driver.mjs` + `probe-extension.ts`）：spawn `pi --mode rpc --extension probe-extension.ts --model deepseek/<model>`，driver 读 stdout JSONL：工具 execute 内调 ui 原语 → pi 发 `extension_ui_request` 消息 → driver 模拟用户回 `extension_ui_response`（value/confirmed/cancelled）或发 RPC `abort` 命令注入中断。全部事件落 `rpc-*.log`，execute 内部事件落 `probe.log`。共跑 8 个用例（select/confirm/input/notify/loop/custom/取消×3）。
2. **TUI 真终端通道**（`tui-run.sh` + tmux 3.6）：tmux pane 跑 `pi --extension probe-extension.ts --model deepseek/<model> --no-session`，真实用户按键（Enter/Esc/数字/字母）驱动，每步 `capture-pane` 落 `tui-*.pane`。共跑 6 场景（select/loop×3/custom×2/input/confirm_seq）。

环境坑记录：tmux 服务器是常驻进程，pane shell 不继承调用方 export——变量须内联进命令串（否则 `--model deepseek/` 解析失败直接崩溃）；tmux 需 `set -g extended-keys on`（否则 Modified Enter 等组合键异常，普通键无碍）。

---

## 二、Q1 · execute 内 ctx.ui 可用性 — **PASS**

**方法**：探测工具 execute 内依次 await `ctx.ui.select/confirm/input`，RPC 观察 `extension_ui_request` 是否发出且响应是否回灌；TUI 观察真终端是否弹选择器/输入框。

**证据（RPC，rpc-q1_select.log）**：
```
[CMD] prompt: 调用 spike_ui_probe 工具，mode=select。
[EVENT] tool_execution_start  toolName:"spike_ui_probe" args:{"mode":"select"}
[UI REQ #1] {"type":"extension_ui_request","id":"98f85d16-...","method":"select","title":"spike select","options":["alpha","beta","gamma"]}
[UI RES] {"value":"beta"}
[EVENT] tool_execution_end ... result:{"content":[{"type":"text","text":"ok"}]} isError:false
```
probe.log（execute 内部）：`execute.enter {"params":{"mode":"select"},"mode":"rpc","hasUI":true,"ctxSignal":true,"execSignal":true}` → `execute.result {"result":{"select":"beta"}}`。confirm（回 confirmed:true）、input（回 "typed-by-driver"）同链路通过。

**证据（TUI，tui-select.pane）**：模型输出 `spike_ui_probe` 工具调用后，真终端弹出选择器：
```
 spike select
 → alpha
   beta
   gamma
 ↑↓ navigate  enter select  escape/ctrl+c cancel
```
Enter 选择后工具完成、模型总结「已调用 spike_ui_probe（mode=select），工具返回 ok」。

**源码佐证**（`dist/core/extensions/runner.js` L459-467）：execute 的 ctx 由 `createContext()` 动态生成，`get ui() { return runner.uiContext }`——即 TUI 模式注入 interactive-mode 的 `createExtensionUIContext()`、RPC 模式注入 rpc-mode 的 RPC 协议实现；`ToolDefinition.execute` 签名（types.d.ts L372）ctx 类型为完整 `ExtensionContext`（ui 为完整 `ExtensionUIContext`，非 ProjectTrust 的受限 Pick）。execute 的第三参 signal 与 `ctx.signal` 在 TUI/RPC 均存在（probe.log 双真）。

**判定**：execute 内 ctx.ui 可用、await 后用户输入经对话框返回、多轮可连续调用。P1-1「permission-gate 是拦截器场景、execute 内从未实证」的质疑解除。

---

## 三、Q2 · 多轮状态交互（汇总卡）— **PASS**

### 3.1 循环 select（select 循环组合）
**RPC**（rpc-q2_loop.log）：execute 内 `for i in 1..3: await select(...)` → 3 个 UI 请求**逐个发出、逐个响应**，互不阻塞：`round 1/3 · block #1 → #2 → #3`，probe.log `loopRounds:["driver-round-1","driver-round-2","driver-round-3"]`。
**TUI**（tui-select.pane + 逐轮截图）：`round 1/3 · block #1` Enter 后**立即**弹出 `round 2/3 · block #2`（观察间隔 2s 内已就位），三轮完成 `loopRounds:["accept","accept","accept"]`。

### 3.2 custom 组件渲染汇总卡（T1-09 形态载体）
`ctx.ui.custom(factory, { overlay: true })` 在 **TUI 模式**渲染自定义组件；**RPC 模式返回 undefined**（rpc-q2_custom_rpc.log：execute.result `{}`，elapsedMs 0；rpc-mode.js L152-153 注释「Custom UI not supported in RPC mode」）。源码佐证：`showExtensionCustom`（interactive-mode.js）为完整 TUI 组件通路。

汇总卡最小实现（probe-extension.ts custom 分支）：组件持有 `blocks:["pending","pending","pending"]` 状态，`handleInput` 处理 `1/2/3` 逐块翻转（pending→accepted→rejected 循环）、`a` 全收、`r` 全拒、Enter 提交 `done({blocks})`、Esc/q 取消 `done(undefined)`；`render(width)` 输出带色卡片；每次按键 `cached=undefined` 触发重绘。

**TUI 逐键留证**（tui-custom.pane 摘录）：
```
 SPIKE SUMMARY CARD — 3 blocks
 block 1: · PENDING          ← 初始
 block 2: · PENDING
 block 3: · PENDING
 1/2/3 flip block · a accept all · r reject all · Enter submit · Esc/q cancel
```
按 `1` → `block 1: ✓ ACCEPTED`；按 `a` → 三块全 `✓ ACCEPTED`；按 `3` → `block 3: ✗ REJECTED`。Enter 提交后 probe.log：`execute.result {"result":{"custom":{"blocks":["accepted","accepted","rejected"]}}}`——**决策数组完整回传 execute**。Esc 取消：`execute.result {}`（custom 返回 undefined）。

**性能/闪烁观察**：每次按键单次重绘（render 返回 lines，TUI 差分合成），capture-pane 无残影/闪烁；连续 3 轮选择器切换瞬时。execute 阻塞期间 agent 侧显示 `⠴ Working...`（工具执行中预期状态）。

**判定**：多轮状态交互用 `custom()`（TUI）或 `select/input` 循环（RPC）均可实现；汇总卡形态在 TUI 成立。按键协议 `y<n>/n<n>` 双键序列可在组件内缓冲（handleInput 收到逐键事件，组件可自由实现缓冲/组合），无原语障碍。

---

## 四、Q3 · 取消可感知 — **PASS（有实现前提）**

### 4.1 对话框内取消（用户主动取消）
- **TUI**：选择器/输入框底部明示 `escape/ctrl+c cancel`。select 弹出后按 Escape → 选择器关闭、execute 立即完成（probe.log：`elapsedMs:1186`，`result:{}` = select 返回 undefined）。custom 组件 Esc → `done(undefined)` → execute 完成。
- **RPC**：driver 回 `{"cancelled":true}` → select 返回 undefined（rpc-q3_cancel_select.log）。

### 4.2 agent 中断注入（abort 命令 → execute 的 signal）
**对照实验**（rpc-q3_abort_mid vs rpc-q3_abort_noopts，其余条件相同，仅对话框是否传 `opts.signal`）：
| 场景 | 行为 | 结论 |
|---|---|---|
| select 带 `opts.signal=execute信号` + RPC `abort` 命令 | 对话框**立即关闭**、select 返回 undefined、execute 完成、agent_settled | 中断可感知 → 工具可返回 cancelled |
| select **不传** opts.signal + RPC `abort` 命令 | 8s 内 execute 无返回、probe.log 无 execute.result（挂起）、对话框留在 pending | 中断不可感知 |

**源码佐证**：RPC `createDialogPromise`（rpc-mode.js L62-73）与 TUI `showExtensionSelector`（interactive-mode.js L1928-1942）均只在 `opts.signal` 上挂 abort 监听；对话框本身不自动订阅 agent abort。agent 循环把 run 级 signal 直传 execute 第三参（pi-agent-core agent-loop.js L457），`agent.abort()` 触发该 signal（agent.js L202-203；TUI 下 Esc=interrupt 是 agent abort 路径，Ctrl+C=clear/exit，底部帮助原文）。

**结论**：**「用户 Esc/取消 → execute 内可感知」成立**（对话框返回值 undefined/false/自定义 done(undefined)）；**「agent abort 注入 → 对话框自动关闭」必须显式接线**：`await ctx.ui.select(..., { signal: execSignal })`。T1-09 的 `{status:"cancelled"}` 分支（P1-1①）可达，且能区分两种取消来源（返回值 undefined=用户取消；`signal.aborted`=agent 中断）。

---

## 五、Q4 · D6 保底路径（逐块 confirm 序列）— **PASS**

**RPC**（rpc-q4_confirm_seq.log）：3 次 confirm 请求逐个发出，driver 交替回 confirmed:true/false → probe.log `confirmSeq:[false,true,false]`。
**TUI**（tui-select.pane confirm_seq 段）：confirm 呈现为 Yes/No 两选项选择器；驱动 Enter(Yes) → Esc(No) → Enter(Yes) → probe.log `confirmSeq:[true,false,true]`（Esc 取消 confirm 返回 false = 拒绝，语义正确）。

**判定**：逐块 confirm 序列在双模式均成立，产出等价决策数组，D6 B 退化不丢 F1。

---

## 六、T1-09 形态建议（采纳形态：方案 A 汇总卡，custom 组件；保底 B 备留）

### 形态裁决
- **主形态 = 方案 A 汇总卡**：execute 内 `ctx.ui.custom(SummaryCardComponent, { overlay: true })` 一次呈现全部块；组件内状态机承载「逐块翻转 + 全收/全拒 + 即时上屏 + 提交/取消」。Q2 实证成立（渲染/翻转/提交/取消全链路），交互体验与原型对齐度最高。
- **保底 B 逐块 confirm 序列**：保留为两条退化路径——(a) TUI 下 custom 渲染异常时的兜底；(b) **RPC/SDK 嵌入模式**的形态（custom 不可用，用 select 循环或 confirm 序列；RPC 消费端可自行实现汇总卡 UI 并走 extension_ui_response 协议）。

### CliDecisionPort.ask 接口草案（供 T1-09 采纳）
```ts
// 交互层：只在 ask 内实现，不写 L1 判断
async function ask(req: DecisionRequest, ctx: ExtensionContext): Promise<Decision> {
  const dlgOpts = { signal: ctx.signal };           // 关键：显式接 execute signal（Q3 前提）
  if (ctx.mode === "tui" && ctx.hasUI) {
    const r = await ctx.ui.custom<SummaryCardResult | undefined>(
      (tui, theme, kb, done) => new SummaryCard(tui, theme, kb, req, done),  // 组件实现汇总卡
      { overlay: true, ...dlgOpts },                 // 确认 custom 是否接受 opts.signal（实现时核验）
    );
    return r ? { status: "resolved", decisions: r.decisions } : { status: "cancelled" };
  }
  // 保底 B / RPC：逐块 select 或 confirm 序列（每块一次，全决才提交）
  const decisions = [];
  for (const block of req.blocks) {
    const v = await ctx.ui.confirm(block.title, block.summary, dlgOpts);
    decisions.push({ blockId: block.id, accepted: v });
  }
  return { status: "resolved", decisions };
}
```
要点：
1. **所有对话框一律传 `{ signal: ctx.signal }`**（Q3 硬前提；ctx.signal 与 execute 第三参同源，用 ctx.signal 更贴 ExtensionContext 契约）。
2. 汇总卡组件：块状态数组 + handleInput（含 `y<n>`/`n<n>` 缓冲、`a`/`r`、回车提交、`q`/Esc 取消）+ render 差分重绘（实测无闪烁）。
3. 取消（undefined/Esc）→ `{ status: "cancelled" }`，不清理领域状态（T1-05 pending 保留语义不变）。
4. RPC 模式走保底 B（custom 不可用）；如需 RPC 汇总卡，由 RPC 宿主实现 UI 侧。
5. 验收断言兼容：T1-09 卡的「stub ui 模拟按键序列」集成测试仍成立（stub 掉 ctx.ui 后逻辑与按键序列一一对应）。

---

## 七、H7 落档

**H7（execute 内 ctx.ui 可用性与多轮交互能力边界）→ 解除（可用），附边界**：
- 可用：execute 内 select/confirm/input 全通（双模式）；多轮循环交互成立；TUI 下 custom() 可渲染完整状态组件（汇总卡形态）。
- 边界（T1-09 实现必须遵守）：① custom 仅 TUI（RPC 返回 undefined）→ RPC 用保底 B；② 对话框不自动订阅 agent abort，取消可感知需显式传 `opts.signal`（execute signal）；③ 对话框内 Esc/Ctrl+C 被对话框消费为「用户取消」（返回值 undefined/false），对话框外 Esc 才是 agent interrupt。
- D6 B 保底路径保留为退化与 RPC 形态，不弃用。

---

## 八、pi API 与文档不符 / 新发现

1. **execute 的 ctx.ui 是完整 ExtensionUIContext**（含 custom/editor/onTerminalInput），非 ProjectTrust 场景的受限 Pick——T1-07 未涉足此面，本次实证补上。
2. **custom 在 RPC 模式的文档行为**：d.ts 注释只有「Custom UI not supported in RPC mode」，实测为同步返回 `undefined`（非 reject、非 throw），execute 无感知地继续——RPC 消费者必须自己判断 mode。
3. **对话框 `opts.signal` 是取消接线的唯一通道**：ui 原语不订阅 execute 的 signal（隐含契约，源码可证、行为实证），文档未强调——本次 spike 用对照实验钉死。
4. **TUI 全局键位**（底部帮助原文）：`escape interrupt · ctrl+c/ctrl+d clear/exit`——Esc 是 agent 中断（execute signal 来源），Ctrl+C 不中断 agent 而是清屏/退出；与「Ctrl+C 取消」的直觉不同，T1-09 取消分支的用户路径应主打 Esc/`q`（选择器内 Ctrl+C 同样=取消对话框，双路径皆通）。
5. 模型名解析失败报错不友好（`--model deepseek/` 空名时 TypeError 而非清晰报错）——环境坑记录，非本卡范围。

---

STATUS: DONE —— spike 四问有结论（Q1-Q4 全 PASS，Q3 附「必须传 opts.signal」前提），T1-09 形态已建议（A 汇总卡 custom 组件为主 + B 逐块 confirm 保底/RPC），H7 已落档（解除+三条边界），双通道证据齐备（RPC 8 用例 + TUI 6 场景，probe.log/rpc-*.log/tui-*.pane 留存）
