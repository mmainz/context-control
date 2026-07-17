import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { RepositoryIdentity } from "./types";

async function canonicalize(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function gitPath(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  const result = await pi.exec("git", args, { cwd, timeout: 2000 });
  if (result.code !== 0) return undefined;

  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

export async function resolveRepositoryIdentity(
  pi: ExtensionAPI,
  cwd: string,
): Promise<RepositoryIdentity> {
  const worktreeRoot = await gitPath(pi, cwd, ["rev-parse", "--show-toplevel"]);
  const gitCommonDir = await gitPath(pi, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);

  if (worktreeRoot && gitCommonDir) {
    const canonicalWorktreeRoot = await canonicalize(worktreeRoot);
    const canonicalGitCommonDir = await canonicalize(gitCommonDir);
    const repositoryId = `git:${canonicalGitCommonDir}`;

    return {
      id: repositoryId,
      label: canonicalWorktreeRoot,
      configKey: hashKey(repositoryId),
      worktreeRoot: canonicalWorktreeRoot,
      gitCommonDir: canonicalGitCommonDir,
    };
  }

  const canonicalCwd = await canonicalize(cwd);
  const repositoryId = `path:${canonicalCwd}`;

  return {
    id: repositoryId,
    label: canonicalCwd,
    configKey: hashKey(repositoryId),
    worktreeRoot: canonicalCwd,
  };
}
