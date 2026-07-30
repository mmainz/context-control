import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { defaultConfig } from "./config";
import { createRuntimeConfigLoader } from "./runtime";
import type { RepositoryIdentity } from "./types";

const pi = {} as ExtensionAPI;
const repository: RepositoryIdentity = {
  id: "git:/repo/.git",
  label: "/repo",
  configKey: "abc123",
  worktreeRoot: "/repo",
  gitCommonDir: "/repo/.git",
};

describe("runtime config loader", () => {
  it("caches repository identity while loading fresh config", async () => {
    const resolveRepositoryIdentity = vi.fn(() => Promise.resolve(repository));
    let loads = 0;
    const loadConfig = vi.fn(() => {
      loads += 1;
      const config = defaultConfig(repository);
      config.skills = loads === 1 ? { mode: "all" } : { mode: "none" };
      return Promise.resolve({ config, path: `/config/${loads}.json` });
    });
    const loader = createRuntimeConfigLoader(pi, {
      resolveRepositoryIdentity,
      loadConfig,
    });

    await expect(loader.load("/repo")).resolves.toMatchObject({
      configPath: "/config/1.json",
      config: { skills: { mode: "all" } },
    });
    await expect(loader.load("/repo")).resolves.toMatchObject({
      configPath: "/config/2.json",
      config: { skills: { mode: "none" } },
    });
    expect(resolveRepositoryIdentity).toHaveBeenCalledTimes(1);
    expect(loadConfig).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent repository resolution", async () => {
    let finishResolution: ((value: RepositoryIdentity) => void) | undefined;
    const resolveRepositoryIdentity = vi.fn(
      () =>
        new Promise<RepositoryIdentity>((resolve) => {
          finishResolution = resolve;
        }),
    );
    const loadConfig = vi.fn(() =>
      Promise.resolve({
        config: defaultConfig(repository),
        path: "/config.json",
      }),
    );
    const loader = createRuntimeConfigLoader(pi, {
      resolveRepositoryIdentity,
      loadConfig,
    });

    const first = loader.load("/repo");
    const second = loader.load("/repo");
    finishResolution?.(repository);
    await Promise.all([first, second]);

    expect(resolveRepositoryIdentity).toHaveBeenCalledTimes(1);
    expect(loadConfig).toHaveBeenCalledTimes(2);
  });

  it("invalidates identity for a new cwd or after clear", async () => {
    const resolveRepositoryIdentity = vi.fn((_pi, cwd: string) =>
      Promise.resolve({
        ...repository,
        label: cwd,
      }),
    );
    const loadConfig = vi.fn((resolved: RepositoryIdentity) =>
      Promise.resolve({
        config: defaultConfig(resolved),
        path: "/config.json",
      }),
    );
    const loader = createRuntimeConfigLoader(pi, {
      resolveRepositoryIdentity,
      loadConfig,
    });

    await loader.load("/repo");
    await loader.load("/other");
    loader.clear();
    await loader.load("/other");

    expect(resolveRepositoryIdentity).toHaveBeenCalledTimes(3);
  });

  it("retries repository resolution after a failure", async () => {
    const resolveRepositoryIdentity = vi
      .fn<(_pi: ExtensionAPI, _cwd: string) => Promise<RepositoryIdentity>>()
      .mockRejectedValueOnce(new Error("git failed"))
      .mockResolvedValue(repository);
    const loadConfig = vi.fn(() =>
      Promise.resolve({
        config: defaultConfig(repository),
        path: "/config.json",
      }),
    );
    const loader = createRuntimeConfigLoader(pi, {
      resolveRepositoryIdentity,
      loadConfig,
    });

    await expect(loader.load("/repo")).rejects.toThrow("git failed");
    await expect(loader.load("/repo")).resolves.toMatchObject({ repository });
    expect(resolveRepositoryIdentity).toHaveBeenCalledTimes(2);
  });
});
