import { describe, expect, it } from "vitest";
import { NEXTSTEP_DIR_NAME } from "./paths";

describe("paths（H1 落点）", () => {
  it("NEXTSTEP_DIR_NAME 为用户级与项目级共用的目录名常量", () => {
    expect(NEXTSTEP_DIR_NAME).toBe("nextstep");
  });
});
