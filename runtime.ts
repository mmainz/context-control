import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { loadConfig } from "./config";
import { resolveRepositoryIdentity } from "./repo-id";
import type { RuntimeConfig } from "./types";

export async function loadRuntimeConfig(
  pi: ExtensionAPI,
  cwd: string,
): Promise<RuntimeConfig> {
  const repository = await resolveRepositoryIdentity(pi, cwd);
  const { config, path } = await loadConfig(repository);

  return {
    repository,
    configPath: path,
    config,
  };
}
