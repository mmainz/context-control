import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config";
import { resolveRepositoryIdentity } from "./repo-id";
import type { RepositoryIdentity, RuntimeConfig } from "./types";

interface RuntimeConfigLoaderDependencies {
  resolveRepositoryIdentity(
    pi: ExtensionAPI,
    cwd: string,
  ): Promise<RepositoryIdentity>;
  loadConfig(
    repository: RepositoryIdentity,
  ): Promise<{ config: RuntimeConfig["config"]; path: string }>;
}

export interface RuntimeConfigLoader {
  load(cwd: string): Promise<RuntimeConfig>;
  clear(): void;
}

export function createRuntimeConfigLoader(
  pi: ExtensionAPI,
  dependencies: RuntimeConfigLoaderDependencies = {
    resolveRepositoryIdentity,
    loadConfig,
  },
): RuntimeConfigLoader {
  let cachedCwd: string | undefined;
  let repositoryPromise: Promise<RepositoryIdentity> | undefined;

  function resolveRepository(cwd: string): Promise<RepositoryIdentity> {
    if (!repositoryPromise || cachedCwd !== cwd) {
      cachedCwd = cwd;
      repositoryPromise = dependencies.resolveRepositoryIdentity(pi, cwd);
      void repositoryPromise.catch(() => {
        if (cachedCwd === cwd) repositoryPromise = undefined;
      });
    }

    return repositoryPromise;
  }

  return {
    async load(cwd: string): Promise<RuntimeConfig> {
      const repository = await resolveRepository(cwd);
      const { config, path } = await dependencies.loadConfig(repository);

      return {
        repository,
        configPath: path,
        config,
      };
    },
    clear(): void {
      cachedCwd = undefined;
      repositoryPromise = undefined;
    },
  };
}
