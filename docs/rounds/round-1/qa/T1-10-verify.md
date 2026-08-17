# T1-10 独立验收记录（verifier，opus）

- 验收对象：六工具注册表（`src/pi/doc-tools.ts`）+ doc 会话装配（`src/pi/session-assembly.ts`）+ 6 个修改文件 + 2 个测试文件（29 条）
- 环境：/tmp 干净副本（rsync 排除 node_modules 后全新 install）、原仓库真模型冒烟（.env.pi-test · deepseek-v4-flash · pi 0.84.2 · tmux）
- 方法：门禁三连复跑 + 自写独立驱动（`/tmp/t1-10-clean/.../v10-verify.test.ts`，13 条，不采信实现者测试）+ diff 逐文件审计 + P3① 撤行真红性验证 + tui-smoke.sh 复跑 + 取消路径真 TUI 驱动（实现者未冒烟分支）

## 1. 干净态复跑门禁

| 步骤 | 结果 |
|---|---|
| rm -rf node_modules → npm install | ✅ |
| npm run typecheck | ❌ **红**：`src/pi/session-assembly.ts(64,18)` / `(66,15)` TS2304 Cannot find name `DecisionPort` / `AuditPort`（缺 `import type { AuditPort, DecisionPort } from "../domain/gate/ports"`，两类型确在 ports.ts 导出，无全局声明兜底） |
| npm test | ✅ 238/238（vitest 经 esbuild 剥类型，掩盖了类型错误） |

## 2. AC 逐条独立验证（自写驱动，13/13 过）

- **AC-1.3 物理禁用** ✅：真启动 inMemory 会话（stub 模型捕获 pi 真发给 LLM 的 `context.tools`），断言模型可见工具面无 write/edit/bash、含六工具 + read/grep；白名单 10 项、excludeTools = [write,edit,bash] 双断言同过。
- **AC-1.4 只读零副作用** ✅（比实现者断言更严）：三只读工具经真会话全链路各调一次后——versions/*.json 逐 byte（Buffer.equals）不变、物化 .md 逐 byte 不变、pending 目录零文件、inMemory custom 审计计数不变。
- **AC-1.1/1.2** ✅：get_artifact_diff(v1,v2)（已物化对）块数 = computeReplaceDiffBlocks(V1,V2)（同对内容 PendingChange 切块）；工具输出块转全 confirmed 后 applyResolvedBlocks 重建 = V2 精确相等；边界 currentVersion=1 → 空 blocks + note「无上一版本可对比」；结构化 JSON 确认回灌进下一轮 LLM 上下文（toolResult 消息直查）。
- **受管路径守卫** ✅+盲区记录：基线（相对/绝对/edit）与四类绕过变体——`./冒烟文档.md`、`../<dir>/冒烟文档.md`、`<root>/./x.md`、`<root>/sub/../x.md`——全部 block（resolve 归一化命中）；read / 非受管路径 / 无 path 参数放行。**盲区**：symlink 别名指向受管 .md → 放行（守卫按字符串比对不做 realpath）；受管侧车目录 `.nextstep/artifacts/managed/<id>/**`（versions/pending/artifact.json）不在受管集合 → 放行。第一期 doc 模式白名单内无任何写类工具，两盲区均无实际暴露面。
- **取消路径** ✅：stub cancelled（会话链路）+ 真 TUI（tmux 按 q）双验——工具结果 note =「已提案未确认，changeId=…，可用 Web 面板或重试处理」，pending/<changeId>.json 真实落盘（baseVersion=1、diffBlocks pending 态）、版本链仅 1.json、物化文件仍为原文。

## 3. 修改文件审计（6 M）

- `harness-adapter.ts`：ctx 第三参为可选参（向后兼容，pi 官方 execute 五参签名 `execute(toolCallId, params, signal, onUpdate, ctx)` 已核对），toolCallGuard 一行接线 `pi.on("tool_call", …)`；ToolCallEventResult `{block, reason, terminate}` 官方语义确认。最小改动 ✅。
- `tool-translation.ts`：五参透传，正确 ✅。
- `audit-port.ts`：`SessionManager` → `Pick<SessionManager, "appendCustomEntry">` 是参数要求**收窄**（真 CLI 扩展侧经 pi.appendEntry 适配成为可能），不引入越权面 ✅。
- `cli-decision-port.ts` P3①：撤掉修复行（`component.cached = undefined`）→ 14 用例中**恰好唯一**新守护用例变红，其余 13 不受影响——真红性 ✅（验毕已还原副本）。
- `cli-decision-port.test.ts` / `index.ts`：守护用例有效；barrel 导出齐全（但 session-assembly 模块本身 typecheck 不过，re-export 一并坏）。
- 旧仓对照：create_artifact / list_artifacts 描述与逻辑确系原样搬（V1.2 doc-tools.ts:105-142/216-252）；propose_edit description + promptGuidelines 双通道原样、execute 换 proposeWithGate；旧仓 :178-192「有未决/无变化 → changeId null」语义经 proposeResult 保留。

## 4. 真模型端到端独立复跑

- **主链路**（tui-smoke.sh 复跑）：真模型建「冒烟文档」v1 → propose_edit → 汇总卡（已决 0/1）→ y1 → a → Enter →「已确认并物化为 v2」。领域终态核对：versions/1.json + 2.json（v2 note = apply pending <changeId>、author=user）、物化文件 = 修改后全文、pending 目录零文件、probe.log assembly.ready 六工具注册。
- **取消分支**（verifier 新增真 TUI，实现者未冒烟）：汇总卡出现后按 q → 见 §2 取消路径结果。全过。
- 备注：probe.ts 在已含同名项目的 WORK 里重启会因 `registry.create({name:"smoke"})` 重名崩（tui-smoke.sh 每次 rm -rf WORK 故未触发）——冒烟脚本可复跑性小坑，不影响产品代码。

## Findings 分级

| 级别 | 问题 | 说明与建议 |
|---|---|---|
| **P0** | typecheck 门禁不过：session-assembly.ts:64,66 缺 `import type { AuditPort, DecisionPort } from "../domain/gate/ports"` | 干净态复跑实证红。修复 = 一行 import；修复后本卡所有 AC 已全部实证通过，可复验直接转 PASS |
| P2 | 守卫窄化：详设 §5.3 与任务卡均写「拦截**任何**工具调用的目标路径」，实现（session-assembly.ts:121）只拦 toolName === write/edit | read 放行有正当理由（list_artifacts 契约明示可轻读），但「任何工具」对未列举写类工具名（apply_patch/自定义工具/filePath 参数名）的纵深意图未落地。第一期无暴露；建议第二期 coding 模式前收口（如：白名单外任意工具含 path 参数命中集合即 block） |
| P2 | 守卫盲区：symlink 别名、受管侧车目录（.nextstep/artifacts/managed/**）均放行 | 字符串比对不做 realpath；侧车不在受管集合。第一期无 write 工具无暴露，记录成色缺口 |
| P3 | 冒烟脚本可复跑性：probe 重名项目崩溃（见 §4 备注） | 给 probe 的 registry.create 加幂等（按 root 查找已有项目）即可 |

信息性：领域 splitLines pop 末尾空行语义（带末尾换行的全文经 propose→apply 回路丢末尾换行）为既有约定非本卡引入，实现者测试已注释规避。

## haiku 质量评价

实现本体是高水准的——AC-1.2 用重建不变量绕开漂移、P3① 守护用例有判别力且真红、冒烟证据链完整、旧仓锚点引用准确；但门禁只跑了 vitest（绿）漏了 typecheck（红），且守卫对「任何工具」的设计文本做了未注明的收窄——纪律执行是短板，代码质量不是。

## 5. 复验（P0 修复后转 PASS）

lead 补 `import type { AuditPort, DecisionPort } from "../domain/gate/ports";`（session-assembly.ts:9）。verifier 独立复验：

- 修复行在原仓库确认存在；
- 干净态全新走（rsync 排除 node_modules → npm install 196 包 → npm run typecheck）：**0 错误**（此前两处 TS2304 清零）；
- npm test：238/238 全绿；
- verifier 13 条独立驱动（v10-verify.test.ts）在修复后代码上复跑：13/13，行为零回归（symlink/侧车盲区输出与首次一致，见 §2）。

P0 关闭。P2×2（守卫「任何工具」收窄为 write/edit、symlink/侧车目录盲区）与 P3×1（probe 重名项目坑）按 findings 表留档挂账，第一期均无实际暴露面。

STATUS: PASS —— 干净态门禁三连全绿（typecheck 0 错 + 238/238）；AC-1.1~1.4、守卫、取消路径、propose_edit 全链路均经独立驱动 + 真模型 TUI 双实证通过；P0（typecheck 缺 import）已修复并复验关闭；P2×2 + P3×1 留档挂账无第一期暴露
