# T1-12 · Web 通用渲染器 + 受管文档面板（S1–S4 全交互）

> 柱子：**可控**（呈现承重实证：presentation 纯数据 + 通用渲染器，D8 出口判据）+ **可追溯返工**（回滚报告读审计数据）
> 让哪条变绿：**S1 / S2 / S3 / S4 全场景（Web 侧）**、D8「第一期即落地受管文档面板全套」；P1-4、P1-5 渲染落点
> 层：L3｜ **新写**（`apps/web/web/`：通用渲染器 + 面板组件；React，不引组件库——N 清单红线）

## 依赖
- 前置卡：T1-11（server 端点全齐）、T1-04（presentation 类型——消费侧对齐）

## 实现要点
- **通用渲染器**（`render(presentation: Presentation)`）：按 Presentation 数据结构画 UI（title/badges/body 各块类型），**零领域判断**——不重算 diff、不判断状态；「新增条目类型两壳零改动」的 Web 侧承重实证（第四期出口判据）。
- **受管文档面板（对齐原型 managed-doc-panel.html 走查基线）**：
  - 文档内联沉浸审阅（D6 方案 B 目标形态）：未改动段落正常显示，改动块高亮卡片嵌原位、块内绿+/红−、block-note；**rolledback 态（P1-5 渲染）**：回滚后 v4 提案块灰化 + 「未生效（v4 提案）」标注、被删段落恢复显示（body.rolled-back 语义，原型 CSS 已实证）
  - 确认分档交互：逐块 ✓/✗ 三色即时变化 + 进度指示（0/5→5/5）+ 「✅ 全部接受」「❌ 全部拒绝」批量 + 批量后单块仍可翻转（混合档）；**有待定块时写回禁用**；写回 = 一次性提交 resolve 端点（**P2-5 交互模型明示：前端本地状态、写回一次性提交，对齐原型；每点即调 resolveBlock 的逐点提交方案不采用**）
  - 版本链抽屉：v1–v4 每版（版本号/归属/时间/摘要）append-only 展示；**有 pending 时回滚按钮禁用**（原型实证守卫的 UI 侧）
  - 方案 C 回滚反馈：回滚后正文切换 + 回滚报告横幅（撤销块数、**「确认过 N 块」——P1-4 数据管线：面板读自家 web-panel.jsonl 审计回放取 artifact_resolved.acceptedBlocks 计数**，非从版本 diff 重算）+ 「查看差异」「撤销回滚」动作（撤销 = 调 undo 端点，正文恢复）
  - EXTERNAL_MODIFIED 提示（S4）：打开面板即显示警告横幅（server 的 checkExternalModification）、版本操作冻结、三动作（查看 diff / 以提案方式合并 / 拒绝采纳恢复系统版本）；**不得静默覆盖或静默丢弃**
  - TOC 滚动链（P2-11）：实现与否由壳渲染自由裁量（presentation DiffRef 块序保证一致），本期不承诺
- 样式对齐原型 CSS 变量（token 不引组件库，N 清单）；无 SSR 复杂性需求，静态页面 + fetch 直连 server。

## 验收断言（可执行）
- [ ] 组件单测（vitest + testing-library 等价）：渲染器按 presentation 数据渲染（diff 块数/kind/state 与输入一致，含 rolledback 灰化态）
- [ ] 面板状态机单测：有待定块写回禁用；批量后单块翻转；有 pending 回滚禁用
- [ ] 真浏览器走查（browser-e2e skill）：S1–S4 走查表全过（与原型 85 项断言对齐，回滚报告「确认过 N 块」数值正确——用 3 收 2 拒 fixture 验证非巧合相等）
- [ ] 渲染器零领域判断：组件树 grep 无 L1 服务调用（只 fetch server 端点 + 画 presentation）

## 完成判据
单测 + 真浏览器走查过 + 逐卡 commit。

---

## 视觉核验落点（2026-08-17 用户拍板 C）

原型识图核验清单（`../prototype/vision-review.md`）整体转入本卡落地：
- **必修 2**：块头元信息文字降权重（退居次要）；滚动链状态节点加粗加高、三态色与灰条拉开区分（兼顾色弱）
- **建议 4**：h2 层级拉大（→23px 级）；块卡片边框减重降「浮」感；三色饱和度微调；「全部接受」主操作按钮加重
- 原型 HTML 本身不改（保真对比基线）；实现直接产出修正后的视觉，交付前经 ui_diff_check（原型 vs 实现）+ analyze_image（美观复核）双重识图核验
