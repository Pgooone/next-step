# T1-09 CliDecisionPort 复核报告（独立验收）

> 验收人：verifier（opus，2026-08-18）
> 对象：`packages/next-step-pi/src/ports/cli-decision-port.ts` + `cli-decision-port.test.ts`（13 条）+ 真 TUI 冒烟证据 `qa/T1-09-smoke/`（实现者 haiku）
> 方法：干净态门禁复跑 + 自写驱动独立验证两条 P1（不 import 实现者测试，`/tmp/t1-09-verify/driver.mjs`，36 断言）+ pi 0.84.2 源码契约逐行核验 + 真 TUI 冒烟完整复跑（真模型 deepseek-v4-flash，key 从 `.env.pi-test` 注入）

## 一、干净态复跑门禁

rm -rf node_modules → npm install（196 包）→ `npm run typecheck`（next-step-pi + next-step-web 双 workspace 无错）→ `npm test`：**15 文件 / 208 tests 全绿**（含 cli-decision-port 13 条）。✓ PASS

## 二、两条 P1 修正的独立验证（自写驱动，36/36 断言过）

fake 按 pi 真实 `showExtensionCustom` 生命周期构造（interactive-mode.js L2124-2186 逐行核过：done=幂等 close、resolve 后框架自动调 `component.dispose()`、factory 抛错 reject），并 patch signal 的 add/removeEventListener 计数证监听真被清理。

### P1① custom 不接受 signal → factory 闭包自建 abort 接线（三时序全过）

| 时序 | 驱动结果 |
|---|---|
| A · 工厂调用后外部 abort | ask 返回 cancelled；done(undefined) 恰一次；监听注册恰 1 个、settle 后移除（remove≥add；settle+框架 dispose 双保险下 removeEventListener 被调两次，幂等无害）；done 后再 abort 无任何副作用；框架 dispose 确被调用 |
| B · 已中止 signal | 不注册任何监听（add=0）直接 cancelled——`queueMicrotask` 防竞态设计与真实「factory 结果 promise 化、closed 后不显示组件」生命周期兼容 |
| C · 正常提交 done 后 abort | 无二次结算（done 计数不变）；dispose 后再 abort 同样安全 |

配套契约核验：实现 factory 四参 `(tui, theme, keybindings, done)` 对齐 types.d.ts L117 真实签名；opts 只传 `{overlay: true}` 无 signal（传了会 TS 报错，typecheck 过 = 没传的旁证）；P1① 的「监听清理防泄漏」经 removeEventListener 计数直接证明，而非只看 finished 幂等兜底。

### P1② Esc 实测 "\x1b" → q/ESC 双路径（过）

- 驱动注入 `"\x1b"` 与 `"q"` 各自独立触发 settle → done(undefined) → cancelled；
- 注入空字符串不触发取消（证明无依赖 `""` 的残留行为路径）；
- grep 源码零 `data === ""` 判断；ESCAPE 常量注释明确标注「勿改回空串判断」。
- 真 TUI 复跑：场景 3 tmux `send-keys Escape` → 卡片消失 + `smoke result: cancelled`（见 §四）。

## 三、交互语义审计（读实现 + 驱动抽验，全过）

| 语义 | 证据 |
|---|---|
| 单键按下当下即翻（冒烟暴露修复的 bug） | 驱动：按 `y` 后仍全待决，按 `1` 的**当下** render 即含 `[✓ 接受]`+`已决 1/5`，不等下一键；真 TUI 复跑 y1 帧 `已决 1/2` 即时上屏 ✓ |
| pending 未全决 Enter 被拒 | done 不触发；提示上屏含待决块号（「仍有 4 块待决（2、3、4、5）」）；下一键清提示 |
| a 全收后可再打回单块（混合档） | a→b3：Enter 仍被拒（「仍有 1 块待决（3）」）→ y3 重决后提交成功；另验 y1→n1→y1 反复翻转、b1 打回待决、r 全拒、越界 y9 无副作用 |
| 保底 B 三触发路径与主形态等价 | ① RPC：mode!=="tui" 且 hasUI=true → 逐块 select 序列产出等价 decisions（spike Q4 实证 RPC select 可用）；② custom 抛错 → catch 退化 select 序列（对齐真实 reject 路径）；③ json/print：hasUI=false → cancelled（无法裁决，pending 由 gate 保留）。select 每次传 `{signal}`（spike 修正建议 4 采纳） |
| 分支设计与官方语义对齐 | types.d.ts L212-214 官方注释：「Use "tui" to guard terminal-only UI such as custom components」+「hasUI: true in TUI and RPC modes」——实现的 `mode==="tui" && hasUI` / `hasUI` / 兜底三分支与官方语义逐字对齐；ExtensionMode 四值（tui/rpc/json/print）全覆盖 |
| 渲染零领域 import | 全文件仅 2 条 import，均为 `import type`（pi ExtensionContext + domain/gate/ports 端口类型）；无计算模块、无 fs、无 UI 重算——块数据全部消费 DecisionRequest 原样字段（tag/anchor/lines[0]） |

取消分支「无领域副作用」：端口层无任何 fs/领域服务调用，cancelled 只透传 Decision；pending 保留由 gate（T1-05 契约）负责，边界干净。

## 四、真 TUI 冒烟独立复跑（tui-smoke.sh 三场景完整复跑，一次过）

环境：pi 0.84.2 + 真模型 deepseek-v4-flash + tmux 逐键驱动（probe.ts 从仓库 qa/ 拷至 /tmp 复跑）。probe.log 三次 execute 与三场景一一对应：

1. resolved · 2 块混合（y1→a→n2→Enter：accept+reject）
2. cancelled（Enter 全 pending 被拒 → q）——重点场景逐帧比对：初始帧 `已决 0/2` 两块待决 → Enter 帧提示「仍有 2 块待决（1、2），拒绝提交——先用 y<n>/n<n> 逐块定夺」上屏 → q 帧卡片消失 + `smoke result: cancelled`，与实现者 smoke.pane **逐字一致**
3. cancelled（tmux Escape 键 → Esc 路径）

## 五、Findings 分级

### P3（不阻断，记录在案）

1. **前缀键不清 render 缓存，提示滞留一帧**。Enter 被拒出提示后紧按 `y`（准备输 y<n>）：hint 变量已清，但 y/n/b 分支不置 `cached = undefined`，render 复用旧帧，提示在画面多留一帧、按数字键才消失。与实现注释「任何按键清除提示」有一帧之差。纯显示滞后，决策语义无影响（驱动钉死）。修法一行：prefix 分支也失效缓存。
2. **probe.ts 注释与实际不符**：注释称「三处分离差异 → 3 块」，实际 `computeReplaceDiffBlocks` 产出 2 块（冒烟帧「已决 0/2」，模型回复亦注意到 3 vs 2）。冒烟覆盖不受影响（2 块仍走全链路），注释宜改。
3. **证据目录位置**：实现者放仓库根 `qa/T1-09-smoke/`，按惯例应挪 `docs/rounds/round-1/qa/`（lead 处理）。另 probe.ts 头注释自称「可丢弃，不进仓库」但已进仓库——建议保留（复跑价值实在）并归位，注释顺带修正。探针硬编码仓库绝对路径，换机不可直接跑（可接受，冒烟证据用途）。

## 六、haiku 质量评价

干净态门禁与三场景真 TUI 冒烟复跑均一次过、13 条测试覆盖全部卡断言并把两条 P1 修正写成直接断言、对 pi 官方 mode/hasUI 语义与 custom 生命周期的踩点准确（opts 不传 signal、factory 四参、dispose 双保险）——实现质量明显高于及格线；瑕疵仅两处 P3 级（前缀键缓存一帧滞后、probe 注释 3 块/2 块不符），无任何交互语义错误。

---

STATUS: PASS —— 干净态 208/208 + 两条 P1 修正经自写驱动独立钉死（①signal 三时序全过且 removeEventListener 计数直接证明监听清理；②"\x1b"/q 双路径各自触发取消、零空串残留）+ 交互语义审计全过（单键即时翻转、pending 拒提交含块号提示、混合档打回、保底 B 三触发等价、渲染零领域 import）+ 真 TUI 冒烟三场景完整复跑与实现者证据逐帧一致；附 P3 三条不阻断（前缀键提示滞留一帧、probe 注释 3/2 块不符、证据目录建议挪 docs/rounds/round-1/qa/ 由 lead 处理）。
