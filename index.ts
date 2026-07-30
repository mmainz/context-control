import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { analyzeContextUsage } from "./context-usage";
import { showContextUsage } from "./context-usage-ui";
import { selectEffectiveSkills } from "./effective-context";
import { countEnabled, staleRefs } from "./filtering";
import { discoverSkills } from "./resources";
import { createRuntimeConfigLoader } from "./runtime";
import { filterSkillSystemPrompt, formatSkillsSection } from "./system-prompt";
import { runContextControlCommand } from "./ui";
import type { RuntimeConfig } from "./types";

const EXTENSION_NAME = "context-control";

function shouldFilterSkills(
  rawOptions: Parameters<typeof formatSkillsSection>[0],
  filteredOptions: Parameters<typeof formatSkillsSection>[0],
): boolean {
  return formatSkillsSection(rawOptions) !== formatSkillsSection(filteredOptions);
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
  const skillItems = await discoverSkills(pi, runtime.repository);
  if (isCancelled()) return;

  const enabledSkills = countEnabled(skillItems, runtime.config.skills);
  const staleCount = staleRefs(skillItems, runtime.config.skills).length;
  const staleSuffix = staleCount > 0 ? `, ${staleCount} stale` : "";
  const status = `${enabledSkills}/${skillItems.length} project skills${staleSuffix}`;

  setStatus(ctx, status);
  const header =
    ctx.mode === "tui"
      ? ctx.ui.theme.fg("accent", ctx.ui.theme.bold("[Context Control]"))
      : "[Context Control]";
  ctx.ui.notify(`${header} ${status} enabled. Run /context-control for details.`, "info");
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
    description: "Configure project skills or inspect effective context-window usage.",
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
      const matches = choices.filter((choice) => choice.value.startsWith(prefix.trimStart()));
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
      const runtime = await runtimeLoader.load(ctx.cwd);
      const options = ctx.getSystemPromptOptions();
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
      runtime.config.skills.mode === "all"
        ? "all project skills"
        : `project skills: ${runtime.config.skills.mode}`;
    setStatus(ctx, text);

    if (ctx.hasUI && (event.reason === "startup" || event.reason === "reload")) {
      const generation = startupSummaryGeneration;
      const isCancelled = () => generation !== startupSummaryGeneration;
      startupSummaryTimer = setTimeout(() => {
        startupSummaryTimer = undefined;
        if (isCancelled()) return;

        void publishStartupSummary(pi, ctx, runtime, isCancelled).catch((error: unknown) => {
          if (isCancelled()) return;
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(
            `context-control: failed to summarize project skills: ${message}`,
            "warning",
          );
        });
      }, 0);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    cancelStartupSummary();
    const runtime = await runtimeLoader.load(ctx.cwd);
    const selection = await selectEffectiveSkills(event.systemPromptOptions, runtime);
    const enabledSkills = selection.project.length - selection.blocked.length;
    const staleCount = staleRefs(selection.project, runtime.config.skills).length;
    const staleSuffix = staleCount > 0 ? `, ${staleCount} stale` : "";
    setStatus(ctx, `${enabledSkills}/${selection.project.length} project skills${staleSuffix}`);

    if (!shouldFilterSkills(event.systemPromptOptions, selection.effectiveOptions)) {
      return undefined;
    }

    const result = filterSkillSystemPrompt({
      currentSystemPrompt: event.systemPrompt,
      baseOptions: event.systemPromptOptions,
      filteredOptions: selection.effectiveOptions,
    });

    if (!result.recognizedSkillSection && !warnedAboutPromptReplacement && ctx.hasUI) {
      warnedAboutPromptReplacement = true;
      ctx.ui.notify(
        "context-control: an earlier extension changed Pi's skill section, so skill filtering may be incomplete for this turn.",
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
