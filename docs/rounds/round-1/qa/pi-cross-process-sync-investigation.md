# 调查 · Web 回滚/撤销与 CLI、真实文件的交互（pi 侧证据）

> 调查人：lead（主会话）/ 时间：2026-08-17 / 触发：用户在原型走查后拍板方案 C（回滚反馈 = 正文切换 + 回滚报告 + 撤销回滚），要求先调查「回滚和撤销是否影响 CLI 或真实文件；CLI 怎么知道我们做了这些操作」。
> 证据来源：pi.dev 官方文档 Extensions 与 Session Format 两页（2026-08-17 抓取全文）。
> 配套调查：`legacy-rollback-investigation.md`（旧仓 V1.2 实现考古，另一 agent 执行中）。

## 结论一：pi 的事件机制是「进程内」的，没有跨进程推送

- 扩展文档的完整事件流（session_start → … → agent_settled）全部是**本进程生命周期事件**；`pi.on(...)`、`session.subscribe()`、`pi.events`（扩展间总线）都只在进程内生效。
- SessionManager API（open/append*/getEntries/buildContextEntries…）是**本地文件读写**，没有任何「监听文件被其他进程写入」的接口。
- 推论：**Web 后端（另一进程）往会话 JSONL 写条目，正在运行的 CLI 不会自动收到任何通知**。「Web 操作 → CLI 立刻知道」不是免费能力。

## 结论二：CLI 感知 Web 操作的三条通道

| 通道 | 机制 | 实时性 | 依据 |
|---|---|---|---|
| ① 数据层天然同步 | 会话 JSONL 与物化文件是同一份磁盘文件；CLI agent 下次 read 文件 / 调 `get_artifact_history` 等领域工具时读到的就是回滚后状态 | 下次读取时 | Session Format：sessions/*.jsonl 是全部状态；自定义条目 `type:"custom"` 持久化、不进 LLM 上下文 |
| ② 文件 watcher → sendMessage | CLI 侧扩展 watch 会话/物化文件，变化时 `pi.sendMessage`（进上下文）或 `ctx.ui.notify`（提示用户） | 近实时（自建） | 官方 example `file-trigger.ts`（"File watcher triggers messages"）；扩展文档明确警告 factory 里不要起 watcher，应在 session_start 起、session_shutdown 收 |
| ③ RPC 模式 | Web 薄壳驱动一个 `pi --mode rpc` 进程，操作走该进程，其扩展与会话在线 | 在线 | 扩展文档 Mode Behavior：`ctx.mode === "rpc"`；D8 第一期 Web 轨已预定「薄 server 或 pi --mode rpc」 |

## 结论三：单 writer 是自守规约，pi 不提供保护

- 文档无任何「多进程同时写同一 session」的锁/冲突处理说明；条目树（id/parentId）是 append-only 追加模型，两个进程并发追加会产生**分叉的兄弟条目**，破坏 leaf 语义。
- 与需求文档 §5.2 规约 3（单 writer）一致：这是我们必须自己守的，不是 pi 给的。

## 结论四（顺带收获，D9/D1 相关）

- 扩展文档明示：`CONFIG_DIR_NAME` 导出常量——「Rebranded distributions can use a different config directory name」。改数据目录名有官方配置位，fork 的品牌层改动可能比预期更小。

## 对方案 C 的设计含义（待旧仓证据合并后定稿）

1. **回滚必然影响真实文件**：回滚 = 领域服务以旧版内容物化新版本 → 物化文件被合法改写。CLI agent 下次读文件即新内容（通道①零成本覆盖）。
2. **撤销回滚 = 又一次回滚**（以 v4 内容生成 v6），同一机制，无新语义。
3. **所有 Web 侧领域操作必须同时落会话条目**（appendEntry 自定义条目，如 `artifact_rollback`）：这是 M2 sourceRef 与 M6 可见性的存储落点，也让 CLI 通过通道①/②看到完整操作史。
4. **挂起的提案与回滚冲突**（真正要设计的点）：若 CLI 会话中存在该文档未裁决的 PendingChange，而上游版本被回滚改变 → 提案基底过期。预判：PendingChange 携带 baseVersion，物化时校验基底仍为最新，否则拒绝并提示重新提案。待旧仓证据确认是否已有此机制。
5. **实时通知为可选增强**：第一期用通道①（零成本）；通道②（file-trigger 范式）作为第二期编排时「跨端协同」的候选，不进第一期范围。

---

## 合并结论（旧仓证据并入，2026-08-17）

> 旧仓考古详见 `legacy-rollback-investigation.md`（investigator，file:line 齐全）。以下为两路证据合并后的最终影响矩阵与设计决策。

### 影响矩阵（方案 C 的回滚/撤销在真实系统里会发生什么）

| 操作 | 真实物化文件 | 版本存储 | 对 CLI 的影响 | CLI 感知路径 |
|---|---|---|---|---|
| Web 回滚 | **原子覆盖**（tmp+rename，artifact-service.ts:115-119）——真实文件被改写为目标版内容，这是产品功能不是副作用 | **追加新 versions/\<n\>.json，不删任何旧版**（回滚=追加新版，:322 注释） | agent 下次 read/调工具读到新内容；若 CLI 侧有挂起提案，resolve 时 If-Match 乐观锁失配 → 干净失败 | 通道①（读时自然同步）；②watcher 为后续增强 |
| Web 撤销回滚 | 同上（= 以 v4 内容再回滚一次） | 同上（v6，note 记录来源） | 同上 | 同上 |
| Web 逐块确认写回 | resolveAndMaterialize → applyResolvedBlocks 重建内容 → submitVersion 覆盖 + **删 pending 文件**（pending-change-service.ts:360-382） | 追加新版 | 同上 | 同上 |

### 旧仓已验证、v2.0 直接沿用的机制

1. **乐观锁**：If-Match + artifact.json version 计数（rollback/submitVersion 均校验）——挂起提案撞上上游回滚时，物化会因 version 失配被拒，**基底过期保护的雏形已存在**（artifact 粒度）。
2. **原子写**：tmp+rename，不会留半截文件。
3. **EXTERNAL_MODIFIED**：写盘前全文内容比对（非哈希非 mtime），失败干净失败不留半截状态。
4. **回滚 = 追加新版**：与原型演示的 append-only 语义完全一致（旧仓实战与原型设计互相印证）。

### 旧仓缺口、v2.0 必须补的（进环节④设计）

1. **无审计**：旧仓全仓无任何会话日志/审计记录，唯一追溯载体是版本快照的 author/note/createdAt。v2.0：所有裁决/回滚/撤销操作**必须写 appendEntry 自定义条目**（如 `artifact_rollback`）——这同时是 M2 sourceRef 与 M6 可见性的存储落点。
2. **pending change 无显式 baseVersion**：乐观锁是 artifact 级粗粒度，提案创建→resolve 之间上游被回滚存在竞态窗口。v2.0：PendingChange 显式携带 baseVersion，物化前校验基底仍为最新，过期则拒绝并提示重新提案（红线「上游有未确认变更不得启动下游」的镜像纪律）。
3. **CLI 无感知增强**：旧仓靠通道①活了二十轮（单用户可行）；v2.0 第一期同样只做通道①，通道②（file-trigger watcher 范式通知 agent「文档被回滚」）列入第二期候选。

### 原型方案 C 的落地口径（本文档调查的直接产出）

- 回滚报告横幅：显示撤销块数（含用户确认过的块数）+ 查看差异 + 撤销回滚；文案注明「版本链与操作记录已写入会话日志（appendEntry）」——把审计机制在原型里演示出来。
- 正文切换：回滚后正文展示目标版内容（提案块灰化未生效、被删段落恢复）；撤销回滚 = 再回滚一次（版本号递增），正文恢复。
