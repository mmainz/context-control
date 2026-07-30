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
  it("defaults invalid config to use all skills", () => {
    expect(parseConfig({}, repository)).toEqual(defaultConfig(repository));
  });

  it("parses discriminated resource policies", () => {
    expect(parseResourcePolicy({ mode: "none" })).toEqual({ mode: "none" });
    expect(
      parseResourcePolicy({
        mode: "allowlist",
        refs: [{ id: "repo:AGENTS.md", path: "/repo/AGENTS.md" }, { bad: true }],
      }),
    ).toEqual({
      mode: "allowlist",
      refs: [{ id: "repo:AGENTS.md", path: "/repo/AGENTS.md" }],
    });
  });

  it("migrates v1 skill policies while dropping context-file policies", () => {
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
      version: 2,
      repository: {
        id: repository.id,
        label: repository.label,
        gitCommonDir: repository.gitCommonDir,
      },
      skills: { mode: "allowlist", refs: [] },
    });
  });

  it("refreshes repository metadata for v2 configs", () => {
    expect(
      parseConfig(
        {
          version: 2,
          repository: { id: "old", label: "old" },
          skills: { mode: "none" },
        },
        repository,
      ),
    ).toEqual({
      version: 2,
      repository: {
        id: repository.id,
        label: repository.label,
        gitCommonDir: repository.gitCommonDir,
      },
      skills: { mode: "none" },
    });
  });
});
