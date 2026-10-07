import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";

import { getPackageDir, type Theme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";

import { makeContextControlReport, renderContextControlReport } from "./report";
import type { ResourceItem, ResourcePolicy, RuntimeConfig } from "./types";

let theme: Theme;

beforeAll(async () => {
  const modulePath = join(
    getPackageDir(),
    "dist",
    "modes",
    "interactive",
    "theme",
    "theme.js",
  );
  const module = (await import(pathToFileURL(modulePath).href)) as {
    getThemeByName: (name: string) => Theme;
  };
  theme = module.getThemeByName("dark");
});

function skill(index: number): ResourceItem {
  const path = `/repo/.pi/skills/skill-${index}/SKILL.md`;
  return {
    ref: {
      id: `repo:.pi/skills/skill-${index}/SKILL.md`,
      path,
      label: `skill-${index}`,
    },
    sourcePath: path,
  };
}

function renderSummary(items: ResourceItem[], policy: ResourcePolicy): string {
  const repository = {
    id: "git:/repo/.git",
    label: "/repo",
    configKey: "test",
  };
  const runtime: RuntimeConfig = {
    repository,
    configPath: "/unused/config.json",
    config: { version: 2, repository, skills: policy },
  };
  const report = makeContextControlReport(runtime, items);
  return stripVTControlCharacters(
    renderContextControlReport(report, theme).render(80).join("\n"),
  );
}

describe("base-command report", () => {
  it("shows policy and counts without listing enabled, ignored, or stale skill names", () => {
    const items = Array.from({ length: 200 }, (_, index) => skill(index));
    const stale = Array.from(
      { length: 100 },
      (_, index) => skill(index + 200).ref,
    );
    const output = renderSummary(items, {
      mode: "blocklist",
      refs: [...items.slice(0, 75).map((item) => item.ref), ...stale],
    });

    expect(output).toContain("Repository: /repo");
    expect(output).toContain("Policy: blocklist");
    expect(output).toContain("Enabled: 125");
    expect(output).toContain("Ignored: 75");
    expect(output).toContain("Stale configured entries: 100");
    expect(output).not.toContain("skill-");
  });

  it.each(["all", "none"] as const)(
    "shows zero counts for an empty %s policy",
    (mode) => {
      const output = renderSummary([], { mode });

      expect(output).toContain(`Policy: ${mode}`);
      expect(output).toContain("Enabled: 0");
      expect(output).toContain("Ignored: 0");
      expect(output).toContain("Stale configured entries: 0");
    },
  );
});
