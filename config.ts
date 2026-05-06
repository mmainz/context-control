import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir as getPiAgentDir } from "@mariozechner/pi-coding-agent";

import type {
  ContextControlConfig,
  RepositoryIdentity,
  ResourcePolicy,
  ResourceRef,
} from "./types";

export function getAgentDir(): string {
  return getPiAgentDir();
}

function getContextControlDir(agentDir = getAgentDir()): string {
  return join(agentDir, "context-control");
}

function getConfigPath(
  repository: RepositoryIdentity,
  agentDir = getAgentDir(),
): string {
  return join(getContextControlDir(agentDir), `${repository.configKey}.json`);
}

export function defaultConfig(
  repository: RepositoryIdentity,
): ContextControlConfig {
  return {
    version: 1,
    repository: {
      id: repository.id,
      label: repository.label,
      ...(repository.gitCommonDir
        ? { gitCommonDir: repository.gitCommonDir }
        : {}),
    },
    contextFiles: { mode: "all" },
    skills: { mode: "all" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResourceRef(value: unknown): ResourceRef | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.path !== "string")
    return undefined;

  return {
    id: value.id,
    path: value.path,
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.group === "string" ? { group: value.group } : {}),
  };
}

function parseRefs(value: unknown): ResourceRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const ref = parseResourceRef(item);
    return ref ? [ref] : [];
  });
}

export function parseResourcePolicy(value: unknown): ResourcePolicy {
  if (!isRecord(value)) return { mode: "all" };

  switch (value.mode) {
    case "none":
      return { mode: "none" };
    case "blocklist":
      return { mode: "blocklist", refs: parseRefs(value.refs) };
    case "allowlist":
      return { mode: "allowlist", refs: parseRefs(value.refs) };
    case "all":
    default:
      return { mode: "all" };
  }
}

export function parseConfig(
  value: unknown,
  repository: RepositoryIdentity,
): ContextControlConfig {
  if (!isRecord(value) || value.version !== 1) return defaultConfig(repository);

  return {
    version: 1,
    repository: {
      id: repository.id,
      label: repository.label,
      ...(repository.gitCommonDir
        ? { gitCommonDir: repository.gitCommonDir }
        : {}),
    },
    contextFiles: parseResourcePolicy(value.contextFiles),
    skills: parseResourcePolicy(value.skills),
  };
}

export async function loadConfig(
  repository: RepositoryIdentity,
  agentDir = getAgentDir(),
): Promise<{ config: ContextControlConfig; path: string }> {
  const path = getConfigPath(repository, agentDir);

  try {
    const raw = await readFile(path, "utf8");
    return { config: parseConfig(JSON.parse(raw), repository), path };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
      throw error;
    }
    return { config: defaultConfig(repository), path };
  }
}

export async function saveConfig(
  path: string,
  config: ContextControlConfig,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, path);
}
