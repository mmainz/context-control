import { realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import type { RepositoryIdentity, ResourceRef } from "./types";

async function canonicalize(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

async function locationInsideWorktree(
  path: string,
  worktreeRoot: string,
): Promise<string | undefined> {
  let ancestor = dirname(path);

  while (true) {
    const canonicalAncestor = await canonicalize(ancestor);
    if (canonicalAncestor === worktreeRoot) {
      return resolve(canonicalAncestor, relative(ancestor, path));
    }

    const parent = dirname(ancestor);
    if (parent === ancestor) return undefined;
    ancestor = parent;
  }
}

export async function createResourceRef(
  path: string,
  repository: RepositoryIdentity,
  options: { label?: string; group?: string } = {},
): Promise<ResourceRef> {
  const resolvedPath = resolve(path);
  const worktreeRoot = repository.worktreeRoot
    ? await canonicalize(repository.worktreeRoot)
    : undefined;
  const worktreeLocation = worktreeRoot
    ? await locationInsideWorktree(resolvedPath, worktreeRoot)
    : undefined;
  const absolutePath = worktreeLocation ?? (await canonicalize(path));

  const id =
    worktreeRoot && worktreeLocation
      ? `repo:${toPortablePath(relative(worktreeRoot, worktreeLocation))}`
      : `abs:${absolutePath}`;

  return {
    id,
    path: absolutePath,
    label: options.label ?? basename(absolutePath),
    ...(options.group ? { group: options.group } : {}),
  };
}
