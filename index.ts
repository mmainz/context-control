import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { analyzeContextUsage } from "./context-usage";
import { showContextUsage } from "./context-usage-ui";
import { selectEffectiveContext } from "./effective-context";
import { countEnabled, staleRefs } from "./filtering";
import { discoverContextFiles, discoverSkills } from "./resources";
import { createRuntimeConfigLoader } from "./runtime";
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

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
  if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, text);
}

async function publishStartupSummary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeConfig,
  isCancelled: () => boolean,
): Promise<void> {
  const [contextFileItems, skillItems] = await Promise.all([
    discoverContextFiles(ctx, runtime.repository),
    discoverSkills(pi, runtime.repository),
  ]);
  if (isCancelled()) return;

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
  const header =
    ctx.mode === "tui"
      ? ctx.ui.theme.fg("accent", ctx.ui.theme.bold("[Context Control]"))
      : "[Context Control]";
  ctx.ui.notify(
    `${header} ${status} enabled. Run /context-control for details.`,
    "info",
  );
}

export default function contextControl(pi: ExtensionAPI) {
  const runtimeLoader = createRuntimeConfigLoader(pi);
  let startupSummaryTimer: ReturnType<typeof setTimeout> | undefined;
  let startupSummaryGeneration = 0;
  let warnedAboutPromptReplacement = false;

  function cancelStartupSummary(): void {
    startupSummaryGeneration += 1;
    if (startupSummaryTimer) clearTimeout(startupSummaryTimer);
    startupSummaryTimer = undefined;
  }

  pi.registerCommand(EXTENSION_NAME, {
    description:
      "Configure project context or inspect effective context-window usage.",
    getArgumentCompletions: (prefix) => {
      const choices = [
        {
          value: "usage",
          label: "usage",
          description: "Show effective context-window usage.",
        },
        {
          value: "usage full",
          label: "usage full",
          description: "Show the full effective context breakdown.",
        },
      ];
      const matches = choices.filter((choice) =>
        choice.value.startsWith(prefix.trimStart()),
      );
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "/context-control requires interactive TUI mode; automatic filtering remains active.",
            "warning",
          );
        }
        return;
      }

      const normalizedArgs = args.trim().replace(/\s+/g, " ").toLowerCase();
      if (
        normalizedArgs.length > 0 &&
        normalizedArgs !== "usage" &&
        normalizedArgs !== "usage full"
      ) {
        ctx.ui.notify(
          "Usage: /context-control, /context-control usage, or /context-control usage full",
          "warning",
        );
        return;
      }

      cancelStartupSummary();
      await ctx.waitForIdle();
      const options = ctx.getSystemPromptOptions();
      const runtime = await runtimeLoader.load(ctx.cwd);
      const openUsage = async (full: boolean): Promise<void> => {
        const currentRuntime = await runtimeLoader.load(ctx.cwd);
        const analysis = await analyzeContextUsage({
          pi,
          ctx,
          runtime: currentRuntime,
          options,
        });
        await showContextUsage(ctx, analysis, full);
      };

      if (normalizedArgs.startsWith("usage")) {
        await openUsage(normalizedArgs === "usage full");
        return;
      }

      await runContextControlCommand(ctx, runtime, options, openUsage);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    cancelStartupSummary();
    const runtime = await runtimeLoader.load(ctx.cwd);
    const text =
      runtime.config.contextFiles.mode === "all" &&
      runtime.config.skills.mode === "all"
        ? "all project context"
        : `project context: ${runtime.config.contextFiles.mode}, project skills: ${runtime.config.skills.mode}`;
    setStatus(ctx, text);

    if (
      ctx.hasUI &&
      (event.reason === "startup" || event.reason === "reload")
    ) {
      const generation = startupSummaryGeneration;
      const isCancelled = () => generation !== startupSummaryGeneration;
      startupSummaryTimer = setTimeout(() => {
        startupSummaryTimer = undefined;
        if (isCancelled()) return;

        void publishStartupSummary(pi, ctx, runtime, isCancelled).catch(
          (error: unknown) => {
            if (isCancelled()) return;
            const message =
              error instanceof Error ? error.message : String(error);
            ctx.ui.notify(
              `context-control: failed to summarize resources: ${message}`,
              "warning",
            );
          },
        );
      }, 0);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    cancelStartupSummary();
    const runtime = await runtimeLoader.load(ctx.cwd);

    const selection = await selectEffectiveContext(
      event.systemPromptOptions,
      runtime,
    );
    const projectContextFileItems = selection.contextFiles.project;
    const projectSkillItems = selection.skills.project;
    const enabledContextFiles =
      projectContextFileItems.length - selection.contextFiles.blocked.length;
    const enabledSkills =
      projectSkillItems.length - selection.skills.blocked.length;
    const staleCount =
      staleRefs(projectContextFileItems, runtime.config.contextFiles).length +
      staleRefs(projectSkillItems, runtime.config.skills).length;
    const staleSuffix = staleCount > 0 ? `, ${staleCount} stale` : "";
    setStatus(
      ctx,
      `${enabledContextFiles}/${projectContextFileItems.length} project context, ${enabledSkills}/${projectSkillItems.length} project skills${staleSuffix}`,
    );

    if (!shouldRebuildPrompt(runtime)) return undefined;

    const result = buildFilteredSystemPrompt({
      currentSystemPrompt: event.systemPrompt,
      baseOptions: event.systemPromptOptions,
      filteredOptions: selection.filteredOptions,
    });

    if (
      !result.preservedChainedChanges &&
      !warnedAboutPromptReplacement &&
      ctx.hasUI
    ) {
      warnedAboutPromptReplacement = true;
      ctx.ui.notify(
        "context-control: an earlier extension changed Pi's resource sections, so resource filtering may be incomplete for this turn.",
        "warning",
      );
    }

    return { systemPrompt: result.systemPrompt };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    cancelStartupSummary();
    runtimeLoader.clear();
    setStatus(ctx, undefined);
  });
}
