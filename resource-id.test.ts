import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createResourceRef } from "./resource-id";
import type { RepositoryIdentity } from "./types";

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "context-control-"));
  temporaryRoots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("resource ids", () => {
  it("uses repo-relative ids for resources inside the worktree", async () => {
    const root = await temporaryDirectory();
    const skillPath = join(root, ".agents", "skills", "demo", "SKILL.md");
    await mkdir(join(root, ".agents", "skills", "demo"), { recursive: true });
    await writeFile(skillPath, "demo", "utf8");

    const repository: RepositoryIdentity = {
      id: "git:/shared/.git",
      label: root,
      configKey: "abc123",
      worktreeRoot: root,
      gitCommonDir: "/shared/.git",
    };

    await expect(createResourceRef(skillPath, repository)).resolves.toMatchObject({
      id: "repo:.agents/skills/demo/SKILL.md",
    });
  });

  it("accepts repository directories whose names begin with two dots", async () => {
    const root = await temporaryDirectory();
    const contextPath = join(root, "..internal", "AGENTS.md");
    await mkdir(join(root, "..internal"), { recursive: true });
    await writeFile(contextPath, "demo");
    const repository: RepositoryIdentity = {
      id: "git:/shared/.git",
      label: root,
      configKey: "abc123",
      worktreeRoot: root,
      gitCommonDir: "/shared/.git",
    };

    await expect(createResourceRef(contextPath, repository)).resolves.toMatchObject({
      id: "repo:..internal/AGENTS.md",
    });
  });

  it("uses absolute ids for resources outside the worktree", async () => {
    const root = await temporaryDirectory();
    const external = await temporaryDirectory();
    const agentsPath = join(external, "AGENTS.md");
    await writeFile(agentsPath, "demo", "utf8");

    const repository: RepositoryIdentity = {
      id: "git:/shared/.git",
      label: root,
      configKey: "abc123",
      worktreeRoot: root,
      gitCommonDir: "/shared/.git",
    };

    const canonicalAgentsPath = await realpath(agentsPath);

    await expect(createResourceRef(agentsPath, repository)).resolves.toMatchObject({
      id: `abs:${canonicalAgentsPath}`,
    });
  });
});
