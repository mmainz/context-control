import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { applyResourcePolicy, countEnabled, staleRefs } from "./filtering";
import {
  contextFilesFromOptions,
  discoverContextFiles,
  discoverSkills,
  isProjectResource,
  pickContextFiles,
  pickSkills,
  skillsFromOptions,
} from "./resources";
import { loadRuntimeConfig } from "./runtime";
import { buildFilteredSystemPrompt } from "./system-prompt";
import { runContextControlCommand } from "./ui";
import type { RuntimeConfig } from "./types";

const EXTENSION_NAME = "context-control";

function shouldRebuildPrompt(runtime: RuntimeConfig): boolean {
  return (
    runtime.config.contextFiles.mode !== "all" ||
    runtime.config.skills.mode !== "all"
  );
}

function setStatus(
  ctx: { ui: { setStatus(key: string, text: string | undefined): void } },
  text: string,
) {
  ctx.ui.setStatus(EXTENSION_NAME, text);
}

async function publishStartupSummary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeConfig,
): Promise<void> {
  const contextFileItems = await discoverContextFiles(ctx, runtime.repository);
  const skillItems = await discoverSkills(pi, runtime.repository);
  const enabledContextFiles = countEnabled(
    contextFileItems,
    runtime.config.contextFiles,
  );
  const enabledSkills = countEnabled(skillItems, runtime.config.skills);
  const staleCount =
    staleRefs(contextFileItems, runtime.config.contextFiles).length +
    staleRefs(skillItems, runtime.config.skills).length;
  const staleSuffix = staleCount > 0 ? `, ${staleCount} stale` : "";
  const status = `${enabledContextFiles}/${contextFileItems.length} project context, ${enabledSkills}/${skillItems.length} project skills${staleSuffix}`;

  setStatus(ctx, status);
  const header = ctx.ui.theme.fg(
    "accent",
    ctx.ui.theme.bold("[Context Control]"),
  );
  ctx.ui.notify(
    `${header} ${status} enabled. Run /context-control for details.`,
    "info",
  );
}

export default function contextControl(pi: ExtensionAPI) {
  pi.registerCommand(EXTENSION_NAME, {
    description:
      "Configure which context files and skills pi should use in this repository.",
    handler: async (_args, ctx) => {
      const runtime = await loadRuntimeConfig(pi, ctx.cwd);
      await runContextControlCommand(pi, ctx, runtime);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const runtime = await loadRuntimeConfig(pi, ctx.cwd);
    const text =
      runtime.config.contextFiles.mode === "all" &&
      runtime.config.skills.mode === "all"
        ? "all project context"
        : `project context: ${runtime.config.contextFiles.mode}, project skills: ${runtime.config.skills.mode}`;
    setStatus(ctx, text);

    if (event.reason === "startup" || event.reason === "reload") {
      setTimeout(() => {
        void publishStartupSummary(pi, ctx, runtime).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          ctx.ui.notify(
            `context-control: failed to summarize resources: ${message}`,
            "warning",
          );
        });
      }, 0);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = await loadRuntimeConfig(pi, ctx.cwd);

    const contextFileItems = await contextFilesFromOptions(
      event.systemPromptOptions,
      runtime.repository,
    );
    const skillItems = await skillsFromOptions(
      event.systemPromptOptions,
      runtime.repository,
    );

    const projectContextFileItems = contextFileItems.filter(isProjectResource);
    const userContextFileItems = contextFileItems.filter(
      (item) => !isProjectResource(item),
    );
    const projectSkillItems = skillItems.filter(isProjectResource);
    const userSkillItems = skillItems.filter(
      (item) => !isProjectResource(item),
    );

    const keptContextFileItems = [
      ...userContextFileItems,
      ...applyResourcePolicy(
        projectContextFileItems,
        runtime.config.contextFiles,
      ),
    ];
    const keptSkillItems = [
      ...userSkillItems,
      ...applyResourcePolicy(projectSkillItems, runtime.config.skills),
    ];

    const enabledContextFiles = countEnabled(
      projectContextFileItems,
      runtime.config.contextFiles,
    );
    const enabledSkills = countEnabled(
      projectSkillItems,
      runtime.config.skills,
    );
    const staleCount =
      staleRefs(projectContextFileItems, runtime.config.contextFiles).length +
      staleRefs(projectSkillItems, runtime.config.skills).length;
    const staleSuffix = staleCount > 0 ? `, ${staleCount} stale` : "";
    setStatus(
      ctx,
      `${enabledContextFiles}/${projectContextFileItems.length} project context, ${enabledSkills}/${projectSkillItems.length} project skills${staleSuffix}`,
    );

    if (!shouldRebuildPrompt(runtime)) return undefined;

    return {
      systemPrompt: await buildFilteredSystemPrompt({
        ...event.systemPromptOptions,
        contextFiles: pickContextFiles(
          event.systemPromptOptions.contextFiles,
          keptContextFileItems,
        ),
        skills: pickSkills(event.systemPromptOptions.skills, keptSkillItems),
      }),
    };
  });
}
