# T1-10 · 六工具注册表 + doc 会话装配（白名单物理禁写 + 受管路径守卫）

> 柱子：**产能**（工具集交付 = Agent 可用的产物能力）+ **可追溯返工**（propose_edit 落 sourceRef 链起点）+ **可控**（AC-1.3 物理禁写）
> 让哪条变绿：**AC-1.1 / AC-1.2 / AC-1.3 / AC-1.4 全绿（本卡主战场）**、S5 ①②、M2a（sourceRef 随工具写入）
> 层：L2｜ 沿用搬 + 改造（`lib/pi/doc-tools.ts`）+ **新写**（只读三工具、装配）

## 依赖
- 前置卡：T1-05（proposeWithGate）、T1-06（merge 走 gate）、T1-07（registerTool）、T1-09（CliDecisionPort 装配注入）；T1-08 spike 结论（propose_edit 的确认承载）

## 实现要点
- **提议三工具（旧仓 doc-tools.ts 搬 + 改）**：
  - `create_artifact`（:105-142）**原样搬**（仅后端换 L1 新 registry）；`list_artifacts`（:216-252）**原样搬**
  - `propose_edit`（:144-214）**改造**：execute 改为调 `proposeWithGate`（T1-05，deps 注入 CliDecisionPort + AuditPort）；「完整新全文」promptGuidelines 双通道约束原样保留（:166-168）；**取消路径（P1-1①）**返回文本「已提案未确认，changeId=…，可用 Web 面板或重试处理」；有未决/无变化时返回语义保留（:178-192）
- **只读三工具（新写）**，TypeBox schema，返回结构化 JSON（jsonResult 范式）：
  - `get_artifact_diff(artifactId, fromVersion?, toVersion?)`：缺省 = 相邻上一版 → 当前版；**边界（P2-9）：currentVersion=1 无上一版 → 空 blocks + note「无上一版本可对比」**；blocks 含 kind/lines/oldLines/lineStart/lineEnd（LCS ops 直接可推，无需新算法）；零 pending/版本副作用
  - `list_my_artifacts()`：当前 Agent（sourceActor 闭包注入）名下产物 + 当前版本 + 最近改动摘要（末版 note/author/createdAt——回滚 author=user、note 格式旧仓语义保持，P3）
  - `get_artifact_history(artifactId)`：版本链升序 + 每版归属（stage 第一期无 → 字段预留省略）
- **doc 会话装配（session-assembly.ts）**：
  - `DOC_TOOLS_WHITELIST` = 6 工具 + read/grep/glob/list（**物理不含 write/edit/bash**）+ `excludeTools: ["write","edit","bash"]` 双保险（正本 §5.4 能力层禁用，非 prompt）——AC-1.3 直接落点
  - **受管路径 tool_call 守卫**（protected-paths 范式）：拦截任何工具调用的目标路径参数，命中受管集合（`<projectRoot>/.nextstep/artifacts/managed/**` 物化文件）→ `{ block: true, reason: "受管文档禁止直写，请用 propose_edit" }`
  - 闭包注入 projectId / sourceActor（旧仓 :44-51 DocToolDeps 范式）

## 验收断言（可执行，SessionManager.inMemory + stub 模型）
- [ ] **AC-1.3**：doc 会话装配后工具注册表不含 write/edit/bash（白名单 + excludeTools 双重断言）
- [ ] **AC-1.1**：只读三工具逐一调用返回结构化 JSON（含无变化/边界分支）
- [ ] **AC-1.4**：只读三工具调用后 pending 目录为空、版本链不变、无审计条目产生
- [ ] **AC-1.2（P1-6 重写为有判别力且可执行）**：`get_artifact_diff(v2, v3)` 的块**按全收应用后重建 = v3 内容**（与 applyResolvedBlocks 同不变量——用已物化版本对断言，绕开「未物化提案不可 diff」的漂移）
- [ ] `propose_edit` 全流程（stub 确认）：落盘 baseVersion 正确的 PendingChange → 物化新版本 → sourceRef 随 artifact_resolved 写入（M2a）
- [ ] 取消路径：stub 返回 cancelled → 工具结果文本含 changeId 与「已提案未确认」
- [ ] 受管路径守卫：伪造 write 到受管 .md 的 tool_call → `{ block: true }`
- [ ] 有未决时二次 propose → 引导先处理（旧仓 :178-186 回归）

## 完成判据
inMemory 集成测试全绿（AC-1.1~1.4 均有关键断言）+ 逐卡 commit。
