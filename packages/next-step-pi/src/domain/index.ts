/** domain 公共面 barrel（原 @pgoone/next-step-core，ADR-001 B 并入本包）：后续卡按需扩展 re-export。
 * 纪律（ADR-001 B，hermes 同款）：src/domain/ 全目录零 pi import——文件夹边界靠约定 + review 保证。 */
export type * from "./gate/ports";
export * from "./audit/entries";
