import { basename } from "node:path";

import {
  getAgentDir,
  loadSkills,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type Skill,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

import { createResourceRef } from "./resource-id";
import type { RepositoryIdentity, ResourceItem } from "./types";

function contextFileGroup(id: string, path: string, agentDir: string): string {
  if (id.startsWith("repo:")) return "project";
  if (path === agentDir || path.startsWith(`${agentDir}/`)) return "user";
  return "external";
}

function skillLabel(commandName: string): string {
  return commandName.startsWith("skill:") ? commandName.slice("skill:".length) : commandName;
}

function skillGroup(command: SlashCommandInfo): string {
  const { origin, scope, source } = command.sourceInfo;
  return origin === "top-level" ? scope : `${scope}:${source}`;
}

export function isProjectResource(item: ResourceItem): boolean {
  if (item.scope === "project") return true;
  if (item.scope === "user") return false;

  return (
    item.ref.id.startsWith("repo:") ||
    item.ref.group === "project" ||
    item.ref.group?.startsWith("project:") === true
  );
}

async function createContextFileItems(
  contextFiles: Array<{ path: string }>,
  repository: RepositoryIdentity,
): Promise<ResourceItem[]> {
  const agentDir = getAgentDir();
  return Promise.all(
    contextFiles.map(async (file) => {
      const initialRef = await createResourceRef(file.path, repository);
      const ref = {
        ...initialRef,
        label: initialRef.id.startsWith("repo:")
          ? initialRef.id.slice("repo:".length)
          : basename(file.path),
        group: contextFileGroup(initialRef.id, initialRef.path, agentDir),
      };
      return { ref, sourcePath: file.path };
    }),
  );
}

export async function contextFilesFromOptions(
  options: BuildSystemPromptOptions,
  repository: RepositoryIdentity,
): Promise<ResourceItem[]> {
  return createContextFileItems(options.contextFiles ?? [], repository);
}

export async function skillsFromOptions(
  options: BuildSystemPromptOptions,
  repository: RepositoryIdentity,
  settings: { includeExplicitOnly?: boolean } = {},
): Promise<ResourceItem[]> {
  const skills = (options.skills ?? []).filter(
    (skill) => settings.includeExplicitOnly || !skill.disableModelInvocation,
  );

  return Promise.all(
    skills.map(async (skill) => ({
      ref: await createResourceRef(skill.filePath, repository, {
        label: skill.name,
        group:
          skill.sourceInfo.origin === "top-level"
            ? skill.sourceInfo.scope
            : `${skill.sourceInfo.scope}:${skill.sourceInfo.source}`,
      }),
      sourcePath: skill.filePath,
      description: skill.description,
      scope: skill.sourceInfo.scope,
      explicitOnly: skill.disableModelInvocation,
    })),
  );
}

export async function discoverSkills(
  pi: ExtensionAPI,
  repository: RepositoryIdentity,
): Promise<ResourceItem[]> {
  const commands = pi.getCommands().filter(
    (
      command,
    ): command is SlashCommandInfo & {
      sourceInfo: NonNullable<SlashCommandInfo["sourceInfo"]>;
    } => command.source === "skill" && Boolean(command.sourceInfo?.path),
  );
  const hiddenSkillPaths = new Set(
    loadSkills({
      cwd: repository.worktreeRoot ?? repository.label,
      agentDir: getAgentDir(),
      skillPaths: commands.map((command) => command.sourceInfo.path),
      includeDefaults: false,
    })
      .skills.filter((skill) => skill.disableModelInvocation)
      .map((skill) => skill.filePath),
  );
  const seen = new Set<string>();
  const resources: ResourceItem[] = [];

  for (const command of commands) {
    if (hiddenSkillPaths.has(command.sourceInfo.path)) continue;
    if (seen.has(command.sourceInfo.path)) continue;
    seen.add(command.sourceInfo.path);
    resources.push({
      ref: await createResourceRef(command.sourceInfo.path, repository, {
        label: skillLabel(command.name),
        group: skillGroup(command),
      }),
      sourcePath: command.sourceInfo.path,
      ...(command.description ? { description: command.description } : {}),
      scope: command.sourceInfo.scope,
    });
  }

  return resources.filter(isProjectResource);
}

export function pickSkills(skills: Skill[] | undefined, kept: ResourceItem[]): Skill[] {
  if (!skills) return [];
  const keptPaths = new Set(kept.map((item) => item.sourcePath));
  return skills.filter((skill) => skill.disableModelInvocation || keptPaths.has(skill.filePath));
}
