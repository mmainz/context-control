import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  Skill,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FilteredSystemPromptInput } from "./system-prompt";
import type { ResourcePolicy, RuntimeConfig } from "./types";

const mocks = vi.hoisted(() => ({
  loadRuntime: vi.fn(),
  clearRuntime: vi.fn(),
  analyzeContextUsage: vi.fn(),
  showContextUsage: vi.fn(),
  buildFilteredSystemPrompt: vi.fn(),
  runContextControlCommand: vi.fn(),
}));

vi.mock("./context-usage", () => ({
  analyzeContextUsage: mocks.analyzeContextUsage,
}));

vi.mock("./context-usage-ui", () => ({
  showContextUsage: mocks.showContextUsage,
}));

vi.mock("./runtime", () => ({
  createRuntimeConfigLoader: () => ({
    load: mocks.loadRuntime,
    clear: mocks.clearRuntime,
  }),
}));

vi.mock("./system-prompt", () => ({
  buildFilteredSystemPrompt: mocks.buildFilteredSystemPrompt,
}));

vi.mock("./ui", () => ({
  runContextControlCommand: mocks.runContextControlCommand,
}));

import contextControl from "./index";

interface RegisteredCommand {
  getArgumentCompletions?(
    prefix: string,
  ): Array<{ value: string; label: string; description?: string }> | null;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

const repository = {
  id: "git:/repo/.git",
  label: "/repo",
  configKey: "abc123",
  worktreeRoot: "/repo",
  gitCommonDir: "/repo/.git",
};

function simplePolicy(mode: "all" | "none"): ResourcePolicy {
  return mode === "all" ? { mode: "all" } : { mode: "none" };
}

function runtime(
  contextMode: "all" | "none" = "all",
  skillMode: "all" | "none" = "all",
): RuntimeConfig {
  return {
    repository,
    configPath: "/config.json",
    config: {
      version: 1,
      repository: {
        id: repository.id,
        label: repository.label,
        gitCommonDir: repository.gitCommonDir,
      },
      contextFiles: simplePolicy(contextMode),
      skills: simplePolicy(skillMode),
    },
  };
}

function createHarness() {
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, EventHandler>();
  const getCommands = vi.fn(() => []);
  const pi = {
    registerCommand: vi.fn((name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    }),
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    }),
    getCommands,
  } as unknown as ExtensionAPI;

  contextControl(pi);
  return { commands, handlers, getCommands };
}

function createContext(mode: ExtensionContext["mode"] = "tui", hasUI = true) {
  const ui = {
    setStatus: vi.fn(),
    notify: vi.fn(),
    custom: vi.fn(),
    theme: {
      fg: vi.fn((_tone: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    },
  };
  const getSystemPromptOptions = vi.fn(() => ({ cwd: "/repo" }));
  const waitForIdle = vi.fn(() => Promise.resolve());
  const context = {
    cwd: "/repo",
    mode,
    hasUI,
    ui,
    getSystemPromptOptions,
    waitForIdle,
  } as unknown as ExtensionCommandContext;

  return { context, getSystemPromptOptions, ui, waitForIdle };
}

function visibleSkill(name: string, scope: "project" | "user"): Skill {
  const filePath = `/${scope}/${name}/SKILL.md`;
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: `/${scope}/${name}`,
    sourceInfo: {
      path: filePath,
      source: "skills",
      scope,
      origin: "top-level",
    },
    disableModelInvocation: false,
  };
}

beforeEach(() => {
  mocks.loadRuntime.mockReset();
  mocks.clearRuntime.mockReset();
  mocks.analyzeContextUsage.mockReset();
  mocks.showContextUsage.mockReset();
  mocks.buildFilteredSystemPrompt.mockReset();
  mocks.runContextControlCommand.mockReset();
  mocks.loadRuntime.mockResolvedValue(runtime());
  mocks.analyzeContextUsage.mockResolvedValue({ model: { label: "test" } });
  mocks.buildFilteredSystemPrompt.mockReturnValue({
    systemPrompt: "filtered prompt",
    preservedChainedChanges: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("context-control extension", () => {
  it("registers its command and lifecycle handlers", () => {
    const { commands, handlers } = createHarness();

    expect(commands.has("context-control")).toBe(true);
    expect([...handlers.keys()]).toEqual([
      "session_start",
      "before_agent_start",
      "session_shutdown",
    ]);
  });

  it("does not rebuild the prompt when both policies use all", async () => {
    const { handlers } = createHarness();
    const { context } = createContext();
    const event: BeforeAgentStartEvent = {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "base prompt",
      systemPromptOptions: { cwd: "/repo" },
    };

    const result = await handlers.get("before_agent_start")?.(event, context);

    expect(result).toBeUndefined();
    expect(mocks.buildFilteredSystemPrompt).not.toHaveBeenCalled();
  });

  it("filters only project resources and preserves hidden skills", async () => {
    mocks.loadRuntime.mockResolvedValue(runtime("none", "none"));
    const { handlers } = createHarness();
    const { context } = createContext();
    const hiddenSkill = {
      ...visibleSkill("hidden", "project"),
      disableModelInvocation: true,
    };
    const options: BuildSystemPromptOptions = {
      cwd: "/repo",
      contextFiles: [
        { path: "/repo/AGENTS.md", content: "project" },
        { path: "/outside/AGENTS.md", content: "user" },
      ],
      skills: [
        visibleSkill("project", "project"),
        visibleSkill("user", "user"),
        hiddenSkill,
      ],
    };
    const event: BeforeAgentStartEvent = {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "prefix base suffix",
      systemPromptOptions: options,
    };

    const result = (await handlers.get("before_agent_start")?.(
      event,
      context,
    )) as BeforeAgentStartEventResult;

    expect(result).toEqual({ systemPrompt: "filtered prompt" });
    const input = mocks.buildFilteredSystemPrompt.mock.calls[0]?.[0] as
      | FilteredSystemPromptInput
      | undefined;
    expect(input).toMatchObject({
      currentSystemPrompt: "prefix base suffix",
      baseOptions: options,
    });
    expect(input?.filteredOptions.contextFiles).toEqual([
      options.contextFiles?.[1],
    ]);
    expect(input?.filteredOptions.skills).toEqual([
      options.skills?.[1],
      hiddenSkill,
    ]);
  });

  it("rejects the interactive command outside TUI mode", async () => {
    const { commands } = createHarness();
    const { context, ui } = createContext("rpc", true);

    await commands.get("context-control")?.handler("", context);

    expect(mocks.loadRuntime).not.toHaveBeenCalled();
    expect(mocks.runContextControlCommand).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("requires interactive TUI mode"),
      "warning",
    );
  });

  it("uses current system-prompt options in TUI mode", async () => {
    const currentRuntime = runtime();
    mocks.loadRuntime.mockResolvedValue(currentRuntime);
    const { commands } = createHarness();
    const { context, getSystemPromptOptions } = createContext("tui", true);
    const options = { cwd: "/repo", contextFiles: [] };
    getSystemPromptOptions.mockReturnValue(options);

    await commands.get("context-control")?.handler("", context);

    expect(getSystemPromptOptions).toHaveBeenCalledTimes(1);
    expect(mocks.runContextControlCommand).toHaveBeenCalledWith(
      context,
      currentRuntime,
      options,
      expect.any(Function),
    );
  });

  it("opens policy-aware usage analysis from the subcommand", async () => {
    const currentRuntime = runtime();
    mocks.loadRuntime.mockResolvedValue(currentRuntime);
    const { commands } = createHarness();
    const { context, getSystemPromptOptions, waitForIdle } = createContext();
    const options = { cwd: "/repo", skills: [] };
    getSystemPromptOptions.mockReturnValue(options);

    await commands.get("context-control")?.handler("usage full", context);

    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(mocks.runContextControlCommand).not.toHaveBeenCalled();
    expect(mocks.analyzeContextUsage).toHaveBeenCalledTimes(1);
    const analysisInput = mocks.analyzeContextUsage.mock.calls[0]?.[0] as
      | {
          pi: ExtensionAPI;
          ctx: ExtensionCommandContext;
          runtime: RuntimeConfig;
          options: BuildSystemPromptOptions;
        }
      | undefined;
    expect(analysisInput).toMatchObject({
      ctx: context,
      runtime: currentRuntime,
      options,
    });
    expect(analysisInput?.pi).toBeDefined();
    expect(mocks.showContextUsage).toHaveBeenCalledWith(
      context,
      { model: { label: "test" } },
      true,
    );
  });

  it("offers usage completions and rejects unknown arguments", async () => {
    const { commands } = createHarness();
    const command = commands.get("context-control");
    const { context, ui } = createContext();

    expect(command?.getArgumentCompletions?.("usage ")).toEqual([
      expect.objectContaining({ value: "usage full" }),
    ]);
    await command?.handler("unknown", context);

    expect(mocks.loadRuntime).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/context-control usage full"),
      "warning",
    );
  });

  it("cancels delayed startup work during session shutdown", async () => {
    vi.useFakeTimers();
    const { handlers, getCommands } = createHarness();
    const { context, ui } = createContext();
    const startEvent: SessionStartEvent = {
      type: "session_start",
      reason: "startup",
    };
    const shutdownEvent: SessionShutdownEvent = {
      type: "session_shutdown",
      reason: "quit",
    };

    await handlers.get("session_start")?.(startEvent, context);
    await handlers.get("session_shutdown")?.(shutdownEvent, context);
    await vi.runAllTimersAsync();

    expect(getCommands).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
    expect(mocks.clearRuntime).toHaveBeenCalledTimes(1);
    expect(ui.setStatus).toHaveBeenLastCalledWith("context-control", undefined);
  });

  it("warns once when an incompatible prompt replacement cannot be merged", async () => {
    mocks.loadRuntime.mockResolvedValue(runtime("none", "all"));
    mocks.buildFilteredSystemPrompt.mockReturnValue({
      systemPrompt: "filtered prompt",
      preservedChainedChanges: false,
    });
    const { handlers } = createHarness();
    const { context, ui } = createContext();
    const event: BeforeAgentStartEvent = {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "replacement",
      systemPromptOptions: { cwd: "/repo" },
    };

    await handlers.get("before_agent_start")?.(event, context);
    await handlers.get("before_agent_start")?.(event, context);

    expect(ui.notify).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("filtering may be incomplete"),
      "warning",
    );
  });
});
