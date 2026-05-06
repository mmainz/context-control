import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { BuildSystemPromptOptions } from "@mariozechner/pi-coding-agent";

type BuildSystemPrompt = (options: BuildSystemPromptOptions) => string;

let cachedBuildSystemPrompt: BuildSystemPrompt | undefined;

export async function buildFilteredSystemPrompt(
  options: BuildSystemPromptOptions,
): Promise<string> {
  if (!cachedBuildSystemPrompt) {
    const packageIndexUrl = import.meta
      .resolve("@mariozechner/pi-coding-agent");
    const packageIndexPath = fileURLToPath(packageIndexUrl);
    const moduleUrl = pathToFileURL(
      join(dirname(packageIndexPath), "core", "system-prompt.js"),
    ).href;
    const module = (await import(moduleUrl)) as {
      buildSystemPrompt: BuildSystemPrompt;
    };
    cachedBuildSystemPrompt = module.buildSystemPrompt;
  }

  return cachedBuildSystemPrompt(options);
}
