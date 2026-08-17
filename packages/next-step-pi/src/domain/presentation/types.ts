/**
 * presentation 纯数据结构（详细设计 §1.4；D6 方案 B 内联 / 方案 A 汇总卡同一份数据）。
 *
 * 条目 payload 自带 presentation；CLI 与 Web 各写一个**通用渲染器**，按数据画、不做领域判断。
 * 新增条目类型 = 新增 payload 类型 + 复用下方 PresentationBlock 组合，两壳渲染器零改动
 * （正本 §5.2 规约 2，第四期出口「新增条目类型两壳零改动」在第一期用本机制承重实证）。
 *
 * 本文件零 pi import、零 IO、零 node 依赖（L1 纪律，high-level-design §5）。
 */

/** 面板顶栏状态徽章（原型 .badge.pending / .badge.ok：「待确认 · 5 块」/「已确认 · v4 已物化」）。 */
export type PresentationBadge = {
  kind: "pending" | "ok";
  text: string;
};

/** 一个待呈现面板：title（原型 .doc-title + .ver 版本区间）+ 徽章 + 正文块（顺序渲染）。 */
export type Presentation = {
  title: string;
  badges: PresentationBadge[];
  body: PresentationBlock[];
};

/**
 * 正文块（原型 managed-doc-panel 的四类呈现元素，结构对齐原型走查断言）：
 * - diff   文档内联 diff 区（方案 B 承重实证核心：改动块卡片嵌原位、块内绿+红−、block-note）
 * - rows   通用行列表（版本链抽屉 .vrow、回滚报告）
 * - banner 横幅（EXTERNAL_MODIFIED 警告 / 回滚报告 / 成功横幅），actions 为渲染器可挂的动作文案
 * - text   纯文本段
 */
export type PresentationBlock =
  | { kind: "diff"; diffRef: DiffRef }
  | { kind: "rows"; rows: Row[] }
  | { kind: "banner"; tone: "warn" | "info" | "ok"; text: string; actions: string[] }
  | { kind: "text"; text: string };

/** 一个版本区间的 diff 引用（原型 verLabel「v3 → v4」；blocks 顺序即文档内顺序，TOC 滚动链同序）。 */
export type DiffRef = {
  artifactId: string;
  fromVersion: number;
  toVersion: number;
  blocks: DiffBlockPresentation[];
};

/**
 * diff 块的呈现数据（对齐原型 .block 卡片）：
 * - tag     「✏️ 修改 1/5」（原型 .block-tag；序号为块在列表中的 1 基全局序号）
 * - anchor  「§2.1 内核策略」（原型 .block-anchor；就近标题推导，尽力而为）
 * - note    「来源：决策记录 D1 · sourceRef 已记」（原型 .block-note）
 * - state   P1-5：加 "rolledback"——回滚后被撤销的提案块灰化标「未生效」（S3④ 渲染依赖），
 *           渲染器按数据画、不猜领域状态。
 */
export type DiffBlockPresentation = {
  blockId: string;
  kind: "add" | "del" | "mod";
  tag: string;
  anchor: string;
  /** add/mod 存新行；del 存旧行。 */
  lines: string[];
  /** mod 旧行（并排渲染用；add/del 省略）。 */
  oldLines?: string[];
  state: "pending" | "confirmed" | "rejected" | "rolledback";
  note?: string;
};

/** 通用行（版本链行：v4 / 设计阶段 · designer / 时间 · note）。 */
export type Row = { key: string; value: string; detail?: string };
