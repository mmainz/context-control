import { describe, expect, it } from "vitest";

import contextControl from "./index";

describe("context-control extension", () => {
  it("exports an extension factory", () => {
    expect(contextControl).toBeTypeOf("function");
  });
});
