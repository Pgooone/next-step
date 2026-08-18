# Next-Step v2.0 路线图（round-1 视角）

> 2026-08-17 整理。全局阶段 + T1 内部执行序 + 两条专项路线（三服务→pi Package、fork 发行轨）。
> 正本需求与拍板：`重构前文档/NextStep-v2.0-需求文档.md`（v3.4）；任务卡：`tasks/`。

## 一、全局阶段

```
✅ 需求定稿 + D1–D10 拍板（2026-08-17，对话留痕见正本 §9）
✅ round-1 环节①②③：需求澄清 / PRD / 原型走查（85 断言全 PASS，基线冻结）
✅ round-1 环节④：概要设计 + 详细设计（评审 PASS，P0=0）+ 13 张任务卡
▶️ round-1 环节⑤：逐卡实现 + 双层验收            ← 当前位置（等 greenlight）
─────────────────────────────────────────────
   T1 出口判据全绿（AC-1.1~1.4 / F1 纯 CLI 端到端 / 手改保护 / 双端一致）
        │
        ├─▶ 发行轨：fork pi 品牌改造 → npm 发布（见第四节，与第二期并行）
        └─▶ 第二期：多 Agent 产线（档案 / Recipe 迁移 / 主脑 / 串行编排）
                第三期：归因闭环（trace_defect / 归因驱动重跑）
                第四期：Web 壳完善（含 EntryDecisionPort 跨端握手解冻）
                （冻结项：M5 自动沉淀、DAG/并行、手动演化入口——见正本 §9 冻结清单）
```

## 二、T1 内部执行序（13 卡，三层）

```
L1 领域内核（纯 TS，不知道 pi 存在，毫秒级单测）
  T1-01 骨架 + .nextstep 路径常量（单点定义）
  T1-02 ⭐三服务原样搬 + 旧测试平移          ← 承重墙 1
  T1-03 baseVersion + 冲突恢复（含 discard 出口）
  T1-04 审计条目族 v1（6 类）+ 端口接口 + sourceRef 格式
  T1-05 闸门编排（提案→确认→物化 + 回滚守卫）
  T1-06 外部手改三动作（查看 / 合并 / 拒绝）
L2 接线（唯一 import pi 的包 = pi 扩展）
  T1-07 HarnessAdapter 6 动作 + AuditPort pi 实现
  T1-08 ⚡SPIKE：真 pi 里实证「汇总卡+快捷键」（形态风险闸门）
  T1-09 CliDecisionPort（spike 结论落地，保底退逐块流式）
  T1-10 六工具注册 + doc 会话装配（物理禁写；AC 主战场）
L3 壳
  T1-11 薄 server（10 端点直调 L1 + web-panel.jsonl 审计）
  T1-12 Web 面板（内联审阅 / 分档确认 / 版本链 / 方案 C 回滚 / 手改警告）
  T1-13 真浏览器 E2E + 出口判据收官
```

依赖序：T1-01→02→03→04→05→06（L1 六连）→ 07 → **08（spike 先行）** → 09 → 10 → 11 → 12 → 13。
全程用 **npm 上游 pi（pin 0.84.2）**，不碰内核源码。

## 三、专项路线：三服务 → pi 的 Package

三服务（artifact-service / pending-change-service / lcs）**不直接**改写成 pi 扩展——它们保持纯 TS（F5 硬约束 + 旧仓病根教训），由扩展层包装暴露：

| 步 | 卡 | 做什么 | 验证点 |
|---|---|---|---|
| 1 搬家 | T1-02 | 三服务 + lcs + file-name **原样搬**进领域目录（签名与语义不动） | 旧仓单测平移全绿（回归护栏） |
| 2 升级 | T1-03~06 | 在领域层补 v2.0 缺口：baseVersion 冲突校验、审计条目、闸门守卫、手改三动作——**仍然不知道 pi** | 纯单测（无模型无终端，毫秒级） |
| 3 包装 | T1-07 | pi 接线层（`src/pi/`，唯一 import pi 的文件夹）：六动作 + AuditPort 的 appendEntry 实现 | `SessionManager.inMemory()` 集成测试 |
| 4 暴露 | T1-09/10 | 六工具注册（create_artifact / propose_edit / list_artifacts + 只读三件套）+ doc 会话装配 | AC-1.1~1.4；工具集物理无 write/edit |
| 5 分发 | 发行轨 | `@pgooone/next-step-pi` 打成 pi 扩展包（官方 Package 机制，`pi install` 可装）；fork 后随 `nextstep` 发行内置 | `pi install` 装上即得六工具 |

> **ADR-001 B 重组后形态（2026-08-17）**：`packages/core` + `packages/pi-ext` 已合并为单包 `packages/next-step-pi`（src/domain 零 pi import 软纪律 / src/pi 接线 / src/ports 审计口），显式翻译官接口已废除。上文步骤 1–3 的「两包」表述为当时历史，物理路径以仓库现状为准。

要点：第 1-2 步的产物永远可以脱离 pi 单测、换地基不重写；「pi 的 Package」身份只发生在第 3-5 步的包装层。

## 四、专项路线：发行轨（两步走，用户拍板 2026-08-18「A 先行再 B」）

**A · 扩展包发行（先行）**：补 pi 扩展入口（default export 工厂 + package.json pi 字段）→ `pi install npm:@pgooone/next-step-pi` 一行安装（用户需已有 pi）——最快真实可用，兼作包形态实战验证。
**B · fork 发行（随后）**：fork 品牌化（CONFIG_DIR_NAME / `nextstep` 命令 / TUI 字样）+ UPSTREAM 纪律 → `npm i -g @pgooone/nextstep` 自带内核的独立产品；内置 A 的扩展包，A 的发布即 B 的组件。

| 步 | 动作 | 说明 |
|---|---|---|
| 1 | fork pi 0.84.2 到 monorepo 的 `pi-fork` | D1 拍板基线；UPSTREAM.md 对照纪律从第一天建立 |
| 2 | 品牌层改造（唯一允许的 diff） | `CONFIG_DIR_NAME="nextstep"`（官方导出，支持 rebrand）、npm 包名 `@pgooone/*`、CLI 命令 `nextstep`、TUI 品牌字样 |
| 3 | 数据目录统一 | 会话目录从 `~/.pi/` 迁到 `.nextstep` 体系——只改 T1-01 的单点常量 + 官方配置位（H1 实证在此步） |
| 4 | 内核 diff 最小化清单登记 | 每条 diff 逐条登记；loop 级改动一律单独评审（D1 纪律） |
| 5 | npm 发布 | `npm i -g @pgooone/nextstep` → `nextstep` 命令 = 内置全部扩展的发行版 |

时机：T1 出口判据全绿后启动；可与第二期开发并行（发行轨只动品牌层，第二期只动扩展/领域层，不冲突）。
