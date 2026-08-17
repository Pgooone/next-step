# pi-fork（L0 内核 fork 占位）

> 本目录是 fork `@earendil-works/pi-coding-agent` 0.84.2 的 vendor 落点（high-level-design §5）。
> **T1-01 仅建占位，不实际引入上游源码**；fork 动作由后续卡（发行轨）执行。

## UPSTREAM 纪律（对照上游，D1 裁决）

fork 改动**只限品牌与发行层**（TUI 字样 / 包名 / CLI 命令名 / 数据目录），领域逻辑零进入：

- 上游版本 pin + 内核 diff 逐条登记表 + 合并流程 → 落 `UPSTREAM.md`
- 每条改动一行：位置 / 改了啥 / 为什么非改不可 / 上游合并策略 → 落 `内核-diff-清单.md`
- 任何 loop 级改动（agent loop / 会话树 / 内置工具行为）须**单独评审 + 登记**，不得随品牌改动混入

目录规划（照 high-level-design §5）：

```
pi-fork/
├── packages/coding-agent/   # fork 内核（占位，待引入）
├── UPSTREAM.md              # 上游版本 pin + 内核 diff 登记表 + 合并流程
└── 内核-diff-清单.md         # 每条改动一行
```
