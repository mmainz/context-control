import { describe, expect, it } from "vitest";

import { defaultConfig, parseConfig, parseResourcePolicy } from "./config";
import type { RepositoryIdentity } from "./types";

const repository: RepositoryIdentity = {
  id: "git:/repo/.git",
  label: "/repo",
  configKey: "abc123",
  worktreeRoot: "/repo",
  gitCommonDir: "/repo/.git",
};

describe("config parsing", () => {
  it("defaults invalid config to use all context and skills", () => {
    expect(parseConfig({}, repository)).toEqual(defaultConfig(repository));
  });

  it("parses discriminated resource policies", () => {
    expect(parseResourcePolicy({ mode: "none" })).toEqual({ mode: "none" });
    expect(
      parseResourcePolicy({
        mode: "allowlist",
        refs: [
          { id: "repo:AGENTS.md", path: "/repo/AGENTS.md" },
          { bad: true },
        ],
      }),
    ).toEqual({
      mode: "allowlist",
      refs: [{ id: "repo:AGENTS.md", path: "/repo/AGENTS.md" }],
    });
  });

  it("refreshes repository metadata while preserving policies", () => {
    expect(
      parseConfig(
        {
          version: 1,
          repository: { id: "old", label: "old" },
          contextFiles: { mode: "blocklist", refs: [] },
          skills: { mode: "allowlist", refs: [] },
        },
        repository,
      ),
    ).toEqual({
      version: 1,
      repository: {
        id: repository.id,
        label: repository.label,
        gitCommonDir: repository.gitCommonDir,
      },
      contextFiles: { mode: "blocklist", refs: [] },
      skills: { mode: "allowlist", refs: [] },
    });
  });
});
