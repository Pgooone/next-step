/**
 * .nextstep 路径常量 —— 单点定义（设计评审 C 节 H1 裁决落点）。
 *
 * 用户级目录 ~/.nextstep 与项目级目录 <projectRoot>/.nextstep 共用此常量。
 * 迁移清单（正本 §7）与 ProjectRegistry 必须引用此常量，不得散落字面量；
 * 后续 fork 实证 CONFIG_DIR_NAME 行为后，只改这一处。
 */
export const NEXTSTEP_DIR_NAME = "nextstep";
