import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { RepositoryIdentity, ResourceRef } from "./types";

async function canonicalize(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

export async function createResourceRef(
  path: string,
  repository: RepositoryIdentity,
  options: { label?: string; group?: string } = {},
): Promise<ResourceRef> {
  const absolutePath = await canonicalize(path);
  const worktreeRoot = repository.worktreeRoot
    ? await canonicalize(repository.worktreeRoot)
    : undefined;

  const id =
    worktreeRoot && isInside(worktreeRoot, absolutePath)
      ? `repo:${toPortablePath(relative(worktreeRoot, absolutePath))}`
      : `abs:${absolutePath}`;

  return {
    id,
    path: absolutePath,
    label: options.label ?? basename(absolutePath),
    ...(options.group ? { group: options.group } : {}),
  };
}
