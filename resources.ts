import { basename, dirname } from "node:path";

import {
  loadProjectContextFiles,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
  type SlashCommandInfo,
} from "@mariozechner/pi-coding-agent";

import { getAgentDir } from "./config";
import { createResourceRef } from "./resource-id";
import type { RepositoryIdentity, ResourceItem } from "./types";

function contextFileGroup(
  refId: string,
  path: string,
  agentDir: string,
): string {
  if (refId.startsWith("repo:")) return "project";
  if (path === `${agentDir}/AGENTS.md` || path.startsWith(`${agentDir}/`))
    return "user";
  return "external";
}

function skillGroup(command: SlashCommandInfo): string {
  const { scope, source } = command.sourceInfo;
  return source === "top-level" ? scope : `${scope}:${source}`;
}

function skillLabel(command: SlashCommandInfo): string {
  return `${command.name.replace(/^skill:/, "")} (${basename(dirname(command.sourceInfo.path))})`;
}

export function isProjectResource(item: ResourceItem): boolean {
  return (
    item.ref.id.startsWith("repo:") ||
    item.ref.group === "project" ||
    item.ref.group?.startsWith("project:") === true
  );
}

async function createContextFileItems(
  contextFiles: Array<{ path: string }>,
  repository: RepositoryIdentity,
  agentDir: string,
): Promise<ResourceItem[]> {
  return Promise.all(
    contextFiles.map(async (file) => {
      const initialRef = await createResourceRef(file.path, repository);
      const ref = await createResourceRef(file.path, repository, {
        label: basename(file.path),
        group: contextFileGroup(initialRef.id, initialRef.path, agentDir),
      });

      return { ref, sourcePath: file.path };
    }),
  );
}

export async function contextFilesFromOptions(
  options: BuildSystemPromptOptions,
  repository: RepositoryIdentity,
): Promise<ResourceItem[]> {
  return createContextFileItems(
    options.contextFiles ?? [],
    repository,
    getAgentDir(),
  );
}

export async function skillsFromOptions(
  options: BuildSystemPromptOptions,
  repository: RepositoryIdentity,
): Promise<ResourceItem[]> {
  const skills = options.skills ?? [];

  return Promise.all(
    skills.map(async (skill) => ({
      ref: await createResourceRef(skill.filePath, repository, {
        label: skill.name,
        group:
          skill.sourceInfo.source === "top-level"
            ? skill.sourceInfo.scope
            : `${skill.sourceInfo.scope}:${skill.sourceInfo.source}`,
      }),
      sourcePath: skill.filePath,
      description: skill.description,
    })),
  );
}

export async function discoverContextFiles(
  ctx: ExtensionContext,
  repository: RepositoryIdentity,
): Promise<ResourceItem[]> {
  const agentDir = getAgentDir();
  const contextFiles = loadProjectContextFiles({ cwd: ctx.cwd, agentDir });

  const resources = await createContextFileItems(
    contextFiles,
    repository,
    agentDir,
  );

  return resources.filter(isProjectResource);
}

export async function discoverSkills(
  pi: ExtensionAPI,
  repository: RepositoryIdentity,
): Promise<ResourceItem[]> {
  const commands = pi
    .getCommands()
    .filter((command) => command.source === "skill");
  const seen = new Set<string>();
  const resources: ResourceItem[] = [];

  for (const command of commands) {
    if (seen.has(command.sourceInfo.path)) continue;
    seen.add(command.sourceInfo.path);

    const item: ResourceItem = {
      ref: await createResourceRef(command.sourceInfo.path, repository, {
        label: skillLabel(command),
        group: skillGroup(command),
      }),
      sourcePath: command.sourceInfo.path,
      ...(command.description ? { description: command.description } : {}),
    };
    resources.push(item);
  }

  return resources.filter(isProjectResource);
}

export function pickContextFiles<T extends { path: string }>(
  contextFiles: T[] | undefined,
  kept: ResourceItem[],
): T[] {
  if (!contextFiles) return [];

  const keptPaths = new Set(kept.map((item) => item.sourcePath));
  return contextFiles.filter((file) => keptPaths.has(file.path));
}

export function pickSkills(
  skills: Skill[] | undefined,
  kept: ResourceItem[],
): Skill[] {
  if (!skills) return [];

  const keptPaths = new Set(kept.map((item) => item.sourcePath));
  return skills.filter((skill) => keptPaths.has(skill.filePath));
}
