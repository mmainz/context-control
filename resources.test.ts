import type { Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  contextFilesFromOptions,
  isProjectResource,
  pickSkills,
  skillsFromOptions,
} from "./resources";
import type { RepositoryIdentity, ResourceItem } from "./types";

const repository: RepositoryIdentity = {
  id: "git:/repo/.git",
  label: "/repo",
  configKey: "abc123",
  worktreeRoot: "/repo",
  gitCommonDir: "/repo/.git",
};

function skill(
  name: string,
  options: {
    scope?: "user" | "project" | "temporary";
    origin?: "package" | "top-level";
    source?: string;
    hidden?: boolean;
  } = {},
): Skill {
  const scope = options.scope ?? "project";
  const source = options.source ?? "skills";
  const filePath = `/${scope}/${source}/${name}/SKILL.md`;
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: `/${scope}/${source}/${name}`,
    sourceInfo: {
      path: filePath,
      source,
      scope,
      origin: options.origin ?? "top-level",
    },
    disableModelInvocation: options.hidden ?? false,
  };
}

describe("resource conversion", () => {
  it("classifies repository context while preserving file content", async () => {
    const contextFiles = [
      { path: "/repo/AGENTS.md", content: "project" },
      { path: "/outside/AGENTS.md", content: "external" },
    ];
    const items = await contextFilesFromOptions({ cwd: "/repo", contextFiles }, repository);

    expect(items[0]?.ref).toMatchObject({
      id: "repo:AGENTS.md",
      label: "AGENTS.md",
      group: "project",
    });
    expect(isProjectResource(items[0]!)).toBe(true);
    expect(isProjectResource(items[1]!)).toBe(false);
  });

  it("labels nested context files with repository-relative paths", async () => {
    const [item] = await contextFilesFromOptions(
      {
        cwd: "/repo",
        contextFiles: [
          {
            path: "/repo/packages/api/AGENTS.md",
            content: "nested",
          },
        ],
      },
      repository,
    );

    expect(item?.ref).toMatchObject({
      id: "repo:packages/api/AGENTS.md",
      label: "packages/api/AGENTS.md",
    });
  });

  it("uses SourceInfo.origin to group top-level and package skills", async () => {
    const topLevel = skill("top-level", {
      origin: "top-level",
      source: "unexpected-source-name",
    });
    const packaged = skill("packaged", {
      origin: "package",
      source: "demo-package",
    });

    const items = await skillsFromOptions(
      { cwd: "/repo", skills: [topLevel, packaged] },
      repository,
    );

    expect(items.map((item) => item.ref.group)).toEqual(["project", "project:demo-package"]);
  });

  it("keeps explicitly user-scoped skills outside project ownership", async () => {
    const userSkill = {
      ...skill("user-inside-repo", { scope: "user" }),
      filePath: "/repo/.pi/skills/user-inside-repo/SKILL.md",
      baseDir: "/repo/.pi/skills/user-inside-repo",
      sourceInfo: {
        path: "/repo/.pi/skills/user-inside-repo/SKILL.md",
        source: "skills",
        scope: "user" as const,
        origin: "top-level" as const,
      },
    };

    const [item] = await skillsFromOptions({ cwd: "/repo", skills: [userSkill] }, repository);

    expect(item?.ref.id).toBe("repo:.pi/skills/user-inside-repo/SKILL.md");
    expect(isProjectResource(item!)).toBe(false);
  });

  it("classifies temporary-scoped skills by repository path", async () => {
    const temporarySkill = {
      ...skill("temporary-project-skill", { scope: "temporary" }),
      filePath: "/repo/.agents/skills/temporary-project-skill/SKILL.md",
      baseDir: "/repo/.agents/skills/temporary-project-skill",
      sourceInfo: {
        path: "/repo/.agents/skills/temporary-project-skill/SKILL.md",
        source: "skills",
        scope: "temporary" as const,
        origin: "top-level" as const,
      },
    };

    const [item] = await skillsFromOptions({ cwd: "/repo", skills: [temporarySkill] }, repository);

    expect(item?.ref.id).toBe("repo:.agents/skills/temporary-project-skill/SKILL.md");
    expect(isProjectResource(item!)).toBe(true);
  });

  it("excludes explicit-only skills from policy inventory", async () => {
    const visible = skill("visible");
    const hidden = skill("hidden", { hidden: true });

    const items = await skillsFromOptions({ cwd: "/repo", skills: [visible, hidden] }, repository);

    expect(items.map((item) => item.ref.label)).toEqual(["visible"]);
  });

  it("preserves explicit-only skills in filtered builder options", () => {
    const visible = skill("visible");
    const blocked = skill("blocked");
    const hidden = skill("hidden", { hidden: true });
    const kept: ResourceItem[] = [
      {
        ref: { id: "visible", path: visible.filePath },
        sourcePath: visible.filePath,
      },
    ];

    expect(pickSkills([visible, blocked, hidden], kept)).toEqual([visible, hidden]);
  });

  it("handles absent resource arrays", async () => {
    await expect(contextFilesFromOptions({ cwd: "/repo" }, repository)).resolves.toEqual([]);
    await expect(skillsFromOptions({ cwd: "/repo" }, repository)).resolves.toEqual([]);
    expect(pickSkills(undefined, [])).toEqual([]);
  });
});
