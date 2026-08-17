# T1-02 独立验收复核（verifier）

> 复核对象：`docs/rounds/round-1/tasks/T1-02-L1三服务原样搬与迁移回归.md`
> 实现产出：`packages/core/src/domain/` 下 6 文件（artifact-service.ts/.test.ts、pending-change-service.ts/.test.ts、lcs.ts、file-name.ts），git untracked 未 commit
> 复核时间：2026-08-17 22:32–22:38 ｜ 方式：干净态复跑门禁 + 全量独立 diff（不采信实现者 diff）+ 两步护栏独立复现 + 红线审计
> 环境：npm（无 pnpm），node ≥20，Linux/WSL2；旧仓基准 `/home/pgoone/GitHubproject/Next-Step/next-step-V1.2/lib/domain/`

---

## 一、干净态复跑门禁

| 步骤 | 命令 | 结果原文（关键行） |
|---|---|---|
| 清空依赖 | `rm -rf node_modules packages/core/node_modules`（pi-fork 内无 node_modules） | 移除后 `find` 零残留 |
| 重装 | `npm install`（workspace 根） | `found 0 vulnerabilities`，exit 0（esbuild postinstall 被 allow-scripts 拦仅 warning，实测不影响 vitest 运行） |
| 类型检查 | `cd packages/core && npx tsc --noEmit` | 零输出，exit 0 |
| 包内测试 | `cd packages/core && npx vitest run` | `Test Files 4 passed (4)` `Tests 100 passed (100)`，exit 0 |
| 复跑稳定性 | 删除复核用护栏目录后再跑全量 | 仍 `100 passed (100)` |

用例分布：paths.test.ts 1 ｜ project-registry.test.ts 15（T1-01 产出，已 commit）｜ pending-change-service.test.ts 42 ｜ artifact-service.test.ts 42。

**结论：干净态门禁全绿。**

---

## 二、保真度全量独立 diff（旧仓 vs 新仓，6 文件逐一）

| 文件 | diff 体量 | md5 对照 | 差异明细（全部列出） |
|---|---|---|---|
| lcs.ts | **0 行** | `db80f8a6…` 双方一致 | 无任何差异，**byte 级一致** ✓ |
| file-name.ts | **0 行** | `5f4ec7f1…` 双方一致 | 无任何差异，**byte 级一致** ✓ |
| artifact-service.ts | 24 行 diff 输出 | 双方不同 | ① `+import { NEXTSTEP_DIR_NAME } from "../config/paths"`（:12）；② `managedDir` :90 `".pi"` → 常量；③ `findArtifact` :376 `".pi"` → 常量；④ 注释同步 4 行（类 doc 2 行 + managedDir doc 1 行 + findArtifact doc 1 行，`.pi` → `.nextstep` 字样） |
| pending-change-service.ts | 14 行 diff 输出 | 双方不同 | ① `+import`（:12）；② `pendingDir` :267 `".pi"` → 常量；③ 注释同步 2 行（类 doc + pendingDir doc） |
| artifact-service.test.ts | 14 行 diff 输出 | 双方不同 | ① `+import`（:12）；② 3 处路径断言字面量换常量（managedArtifactDir helper :44 / findArtifact 误命中测试 :279 / 坏 json 测试 :313）。断言逻辑零改动 |
| pending-change-service.test.ts | 14 行 diff 输出 | 双方不同 | ① `+import`（:25）；② 3 处路径断言字面量换常量（save 落盘 :185 / 原子写 :195 / 坏 json :243）。断言逻辑零改动 |

**声明行号核对**：managedDir :90 / findArtifact :376 / pendingDir :267 —— `grep -n` 精确命中，与声明一致。

**测试结构计数对照**（grep 全文计数，新旧比对）：

| 文件 | describe | it | expect |
|---|---|---|---|
| artifact-service.test.ts | 旧 10 = 新 10 | 旧 42 = 新 42 | 旧 94 = 新 94 |
| pending-change-service.test.ts | 旧 8 = 新 8 | 旧 42 = 新 42 | 旧 79 = 新 79 |

**未声明差异：零。** 所有 diff 行均落入「import + 常量替换 + 注释同步 + 测试路径字面量」四类；无任何逻辑、类型、断言结构差异。

---

## 三、两步护栏独立复现

实现者声明「旧仓原文先跑绿 → 适配后仍绿」。verifier 独立复现：

| 步骤 | 方法 | 结果 |
|---|---|---|
| 第一步：旧仓原文（.pi 字面量版，零适配）在新环境跑 | 旧仓 8 文件（6 卡内文件 + project-registry.ts/.test.ts）原样复制到 `packages/core/src/__guard__/`，用 core 同一 vitest 环境跑（跑毕即删） | `Test Files 3 passed (3)` `Tests 98 passed (98)`（artifact 42 + pending 42 + registry 14），**全绿** ✓ |
| 第二步：适配版 | 即第一节干净态全量 | `100 passed (100)` 全绿 ✓ |
| 用例数守恒 | 域文件口径 42+42 | 原文 84 = 适配 84，**零用例增删** ✓ |

护栏删除后 domain 目录与 git status 恢复实现者产出原状（见第五节）。

---

## 四、卡验收断言核对

| 卡面断言 | 新仓落点（grep 实证） | 结果 |
|---|---|---|
| 平移测试全绿 + 清单 | artifact 42 + pending 42（另 T1-01 已有 registry 15 / paths 1 非本卡范围）；旧仓无 lcs/file-name 独立测试文件，其覆盖内嵌于 pending-change-service.test.ts（splitLines/lcsDiff 经 diffBlocks 间接覆盖），与卡面「找旧仓对应测试文件」表述一致 | ✓ |
| applyResolvedBlocks 不变量 | 全 confirmed = newContent（:461）/ 全 rejected = oldContent（:273）/ 全 pending = oldContent（:281）/ 块数失配抛 INVALID（:328） | ✓ 保留且绿 |
| 乐观锁 If-Match 失配 → VERSION_CONFLICT | :203/:212（submitVersion）、:219（rollback）、:466（deleteArtifact） | ✓ 保留且绿 |
| EXTERNAL_MODIFIED 干净失败 | :416-421（外部改文件后 rollback → EXTERNAL_MODIFIED，不静默覆盖） | ✓ 保留且绿 |
| 回滚追加语义（版本链 +1、旧版全在） | :163-189（回滚到 v1 生成 v4、不删 v1-3、note 含 rollback to v1、currentVersion=4）+ :362（回退后真实文件 == 目标版内容） | ✓ 保留且绿 |
| `grep -rn "@earendil-works" packages/core/` 零命中 | grep exit 1（零命中，源码与测试均无） | ✓ |

---

## 五、红线审计

| 红线 | 命令 | 结果 |
|---|---|---|
| core 零 earendil 残留 | `grep -rn "@earendil-works" packages/core/` | 零命中 ✓ |
| core 源码零 `.pi` 字面量 | `grep -rn '\.pi\b' packages/core/src/` | 零命中 ✓ |
| 未抢跑 T1-03（baseVersion） | `grep -rn "baseVersion" packages/core/src/` | 零命中；`PendingChange` 类型定义（:22-65 区域）无 baseVersion 字段 ✓ |
| 未碰 pi-ext/apps/docs/pi-fork | `git status --short` | 恰好 6 个 untracked = 声明产出，零已跟踪文件被改 ✓ |
| 无投机新增文件 | 同上 + `ls packages/core/src/` | 仅 config/domain 两目录，domain 内 8 文件 = 6 untracked + 2 已 commit（registry，T1-01）✓ |

---

## 六、问题分级

| 级别 | 问题 | 说明 |
|---|---|---|
| **P2-1** | 护栏用例数声明不可复现：实现者称「原文 100 条 → 适配后 102 条」 | 实测：原文域三件套 98 条（42+42+14，若混入 T1-01 的 registry 15 + paths 1 则全套 100）；适配后全套 100。「102」任何口径均无法构造。**实质声明（两步均绿、用例零增删、语义零变）已独立验证全部成立**，纯计数错误——建议 lead 以实测数字回写进度记录，勿采信「102」 |
| P3-1 | artifact-service.ts 注释同步实际 4 行，声明 3 行 | 漏数（类 doc 2 行 + managedDir doc + findArtifact doc）；差异本身在授权的注释同步范围内 |
| P3-2 | 测试替换计数口径不一致：artifact 声明「4 处」、pending 声明「3 处」 | 实际两文件均为「3 处 join 字面量 + 1 处 import」。所有 `.pi` 字面量已确认全替换、无遗漏无多余 |
| INFO-1 | `NEXTSTEP_DIR_NAME = "nextstep"`（无点前缀）与注释/设计文档「.nextstep」（带点）张力 | T1-01 验收 P3-1 已登记，留 T1-08/T1-09 H1 实证裁决；T1-02 注释跟设计文档口径、代码跟常量，属继承张力，非本卡违规。测试断言与实现共用同一常量故天然同变，不构成掩盖 |

**P0/P1：无。**

---

## 七、结论

干净态门禁全绿（install 0 漏洞 / tsc 零错误 / 100 测试全过）；6 文件保真度独立 diff 通过（lcs/file-name byte 级一致，服务文件差异恰为授权适配项，测试断言结构零改且计数守恒）；两步护栏独立复现成立（原文 98 绿 → 适配 100 绿，域用例 84 = 84）；红线五项全过。P2/P3 均为声明记录瑕疵，不动摇产物质量。

STATUS: PASS —— 干净态门禁全绿，保真度独立验证通过，红线无违反
