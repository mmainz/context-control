import { describe, expect, it } from "vitest";

import { applyResourcePolicy, preserveStaleRefs, pruneStaleRefs, staleRefs } from "./filtering";
import type { ResourceItem, ResourceRef } from "./types";

const alpha: ResourceRef = { id: "repo:alpha", path: "/repo/alpha" };
const beta: ResourceRef = { id: "repo:beta", path: "/repo/beta" };
const missing: ResourceRef = { id: "repo:missing", path: "/repo/missing" };
const items: ResourceItem[] = [
  { ref: alpha, sourcePath: alpha.path },
  { ref: beta, sourcePath: beta.path },
];

describe("resource policies", () => {
  it("uses all resources by default", () => {
    expect(applyResourcePolicy(items, { mode: "all" })).toEqual(items);
  });

  it("uses no resources when mode is none", () => {
    expect(applyResourcePolicy(items, { mode: "none" })).toEqual([]);
  });

  it("excludes blocklisted resources", () => {
    expect(applyResourcePolicy(items, { mode: "blocklist", refs: [beta] })).toEqual([items[0]]);
  });

  it("includes only allowlisted resources", () => {
    expect(applyResourcePolicy(items, { mode: "allowlist", refs: [beta, missing] })).toEqual([
      items[1],
    ]);
  });

  it("detects and prunes stale refs", () => {
    const policy = { mode: "allowlist" as const, refs: [alpha, missing] };

    expect(staleRefs(items, policy)).toEqual([missing]);
    expect(pruneStaleRefs(items, policy)).toEqual({
      mode: "allowlist",
      refs: [alpha],
    });
  });

  it("preserves stale refs when saving an edited policy", () => {
    expect(preserveStaleRefs(items, [beta], [alpha, missing])).toEqual([beta, missing]);
  });
});
