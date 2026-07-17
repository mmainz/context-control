import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
  Skill,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { analyzeContextUsage } from "./context-usage";
import {
  allocateBarWidths,
  formatContextUsageLines,
  largestContextConsumers,
  renderUsageVisualization,
} from "./context-usage-ui";
import { formatContextSection, formatSkillsSection } from "./system-prompt";
import type { RuntimeConfig } from "./types";

const repository = {
  id: "git:/repo/.git",
  label: "/repo",
  configKey: "abc123",
  worktreeRoot: "/repo",
  gitCommonDir: "/repo/.git",
};

function skill(
  name: string,
  options: { scope?: "project" | "user"; hidden?: boolean } = {},
): Skill {
  const scope = options.scope ?? "project";
  const root = scope === "project" ? "/repo/.pi/skills" : "/user/skills";
  const filePath = `${root}/${name}/SKILL.md`;
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: `${root}/${name}`,
    sourceInfo: {
      path: filePath,
      source: "skills",
      scope,
      origin: "top-level",
    },
    disableModelInvocation: options.hidden ?? false,
  };
}

function runtime(): RuntimeConfig {
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
      contextFiles: {
        mode: "allowlist",
        refs: [
          {
            id: "repo:allowed.md",
            path: "/repo/allowed.md",
            label: "allowed.md",
          },
        ],
      },
      skills: {
        mode: "allowlist",
        refs: [
          {
            id: "repo:.pi/skills/allowed/SKILL.md",
            path: "/repo/.pi/skills/allowed/SKILL.md",
            label: "allowed",
          },
        ],
      },
    },
  };
}

function harness(selectedTools?: string[]) {
  const allowedSkill = skill("allowed");
  const blockedSkill = skill("blocked");
  const userSkill = skill("user-skill", { scope: "user" });
  const hiddenSkill = skill("hidden", { hidden: true });
  const options: BuildSystemPromptOptions = {
    cwd: "/repo",
    ...(selectedTools ? { selectedTools } : {}),
    contextFiles: [
      { path: "/repo/allowed.md", content: "allowed context" },
      { path: "/repo/blocked.md", content: "blocked context" },
      { path: "/user/AGENTS.md", content: "user context" },
    ],
    skills: [allowedSkill, blockedSkill, userSkill, hiddenSkill],
  };
  const currentSystemPrompt = `base prompt${formatContextSection(options)}${formatSkillsSection(options)}`;
  const pi = {
    getCommands: vi.fn(() =>
      options.skills!.map((item) => ({
        name: `skill:${item.name}`,
        description: item.description,
        source: "skill" as const,
        sourceInfo: item.sourceInfo,
      })),
    ),
    getActiveTools: vi.fn(() => ["read"]),
    getAllTools: vi.fn(() => [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object" },
        promptGuidelines: [],
        sourceInfo: {
          path: "<builtin:read>",
          source: "builtin",
          scope: "temporary" as const,
          origin: "top-level" as const,
        },
      },
    ]),
  } as unknown as ExtensionAPI;
  const getBranch = vi.fn((): SessionEntry[] => []);
  const ctx = {
    cwd: "/repo",
    model: {
      id: "test-model",
      name: "Test Model",
      provider: "test",
      contextWindow: 100_000,
    },
    getSystemPrompt: vi.fn(() => currentSystemPrompt),
    getContextUsage: vi.fn(() => ({
      tokens: 12_000,
      contextWindow: 100_000,
      percent: 12,
    })),
    sessionManager: {
      getBranch,
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, getBranch, options, pi };
}

describe("context usage analysis", () => {
  it("allocates stable bar widths and preserves tiny non-zero segments", () => {
    const widths = allocateBarWidths([1, 49, 50], 100, 20);

    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(20);
    expect(widths[0]).toBeGreaterThan(0);
    expect(allocateBarWidths([0, 0], 100, 20)).toEqual([0, 0]);
  });

  it("applies allowlists while preserving external resources", async () => {
    const { ctx, options, pi } = harness();
    const analysis = await analyzeContextUsage({
      pi,
      ctx,
      runtime: runtime(),
      options,
      compactionReserveTokens: 10_000,
    });

    expect(
      analysis.resources
        .filter((item) => item.visibility === "model-visible")
        .map((item) => item.label)
        .sort(),
    ).toEqual(["AGENTS.md", "allowed", "allowed.md", "user-skill"]);
    expect(
      analysis.resources
        .filter((item) => item.visibility === "blocked-by-policy")
        .map((item) => item.label),
    ).toEqual(["blocked.md", "blocked"]);
    expect(
      analysis.resources.find((item) => item.label === "hidden"),
    ).toMatchObject({
      visibility: "explicit-only",
      tokens: 0,
      slashCommands: ["/skill:hidden"],
    });
    expect(analysis.categories.freeSpace).toBe(78_000);
    expect(analysis.policyImpact.contextFiles.saved).toBeGreaterThan(0);
    expect(analysis.policyImpact.skills.saved).toBeGreaterThan(0);
    expect(analysis.policyImpact.totalSaved).toBe(
      analysis.policyImpact.contextFiles.saved +
        analysis.policyImpact.skills.saved,
    );
  });

  it("keeps blocked skills slash-callable but out of automatic context", async () => {
    const { ctx, options, pi } = harness();
    const analysis = await analyzeContextUsage({
      pi,
      ctx,
      runtime: runtime(),
      options,
      compactionReserveTokens: 0,
    });
    const blocked = analysis.resources.find((item) => item.label === "blocked");

    expect(blocked).toMatchObject({
      visibility: "blocked-by-policy",
      slashCommands: ["/skill:blocked"],
    });
    expect(analysis.systemPrompt.skills).toBeGreaterThan(0);
  });

  it("reports enabled skills as non-visible when read is inactive", async () => {
    const { ctx, options, pi } = harness(["bash"]);
    const analysis = await analyzeContextUsage({
      pi,
      ctx,
      runtime: runtime(),
      options,
      compactionReserveTokens: 0,
    });

    expect(
      analysis.resources
        .filter((item) => item.visibility === "read-tool-disabled")
        .map((item) => item.label)
        .sort(),
    ).toEqual(["allowed", "user-skill"]);
    expect(analysis.systemPrompt.skills).toBe(0);
  });

  it("counts active tool definitions but not inactive tools", async () => {
    const { ctx, options, pi } = harness();
    const analysis = await analyzeContextUsage({
      pi,
      ctx,
      runtime: runtime(),
      options,
      compactionReserveTokens: 0,
    });

    expect(analysis.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(analysis.estimated.toolDefinitions).toBeGreaterThan(0);
  });

  it("does not attribute tool snippets when a custom prompt is active", async () => {
    const { ctx, options, pi } = harness();
    options.customPrompt = "Custom prompt";
    options.toolSnippets = { read: "Read tool snippet" };

    const analysis = await analyzeContextUsage({
      pi,
      ctx,
      runtime: runtime(),
      options,
      compactionReserveTokens: 0,
    });

    expect(analysis.toolSnippets).toEqual([]);
    expect(analysis.systemPrompt.toolSnippets).toBe(0);
  });

  it("counts only entries before compaction's first kept entry as summarized", async () => {
    const { ctx, getBranch, options, pi } = harness();
    getBranch.mockReturnValue([
      {
        id: "old-message",
        parentId: null,
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "old", timestamp: 1 },
      },
      {
        id: "kept-message",
        parentId: "old-message",
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "kept", timestamp: 2 },
      },
      {
        id: "compaction",
        parentId: "kept-message",
        type: "compaction",
        timestamp: "2026-01-01T00:00:02.000Z",
        summary: "summary",
        firstKeptEntryId: "kept-message",
        tokensBefore: 100,
      },
    ]);

    const analysis = await analyzeContextUsage({
      pi,
      ctx,
      runtime: runtime(),
      options,
      compactionReserveTokens: 0,
    });

    expect(analysis.compaction).toEqual({
      active: true,
      summarizedMessages: 1,
    });
  });

  it("uses Pi's compaction-aware message estimator", async () => {
    const { ctx, getBranch, options, pi } = harness();
    getBranch.mockReturnValue([
      {
        id: "message-1",
        parentId: null,
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "user",
          content: "A model-visible user message",
          timestamp: 1,
        },
      },
    ]);

    const analysis = await analyzeContextUsage({
      pi,
      ctx,
      runtime: runtime(),
      options,
      compactionReserveTokens: 0,
    });

    expect(analysis.messages).toHaveLength(1);
    expect(analysis.messages[0]).toMatchObject({
      role: "user",
      summary: "A model-visible user message",
    });
    expect(analysis.categories.userMessages).toBeGreaterThan(0);
    expect(analysis.estimated.conversation).toBe(
      analysis.categories.userMessages,
    );
  });

  it("formats summary and full reports with visibility terminology", async () => {
    const { ctx, options, pi } = harness();
    const analysis = await analyzeContextUsage({
      pi,
      ctx,
      runtime: runtime(),
      options,
      compactionReserveTokens: 0,
    });
    const summary = formatContextUsageLines(analysis, false).join("\n");
    const full = formatContextUsageLines(analysis, true).join("\n");

    expect(summary).toContain("Model-visible skills: 2");
    expect(summary).toContain("Blocked by policy: 2");
    expect(summary).toContain("Explicit-only skills: 1");
    expect(summary).toContain("Total saved by ignored resources:");
    expect(summary).toMatch(
      /Instruction\/context files:.*saved \(.*of window\)/,
    );
    expect(summary).toMatch(/Skill manifest:.*saved \(.*of window\)/);
    expect(full).toContain("[Guidelines]");
    expect(full).toContain("[Tool Snippets]");
    expect(full).toContain("[Blocked Resources]");
    expect(full).toContain("/skill:blocked");
    expect(full).toContain("[Compaction-aware Conversation]");
    expect(full).toContain("[Method]");

    const consumers = largestContextConsumers(analysis);
    expect(consumers.length).toBeGreaterThan(0);
    expect(consumers).toEqual(
      [...consumers].sort((left, right) => right.tokens - left.tokens),
    );
    expect(consumers.some((consumer) => consumer.label === "blocked")).toBe(
      false,
    );

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const visualization = renderUsageVisualization(analysis, true, 40, theme);
    expect(visualization.join("\n")).toContain("[Context Window Map]");
    expect(visualization.join("\n")).toContain("[Resource Footprint]");
    expect(visualization.join("\n")).toContain("saved by ignored resources");
    expect(visualization.join("\n")).toContain("[Largest Context Consumers]");
    expect(visualization.join("\n")).toContain("· free");
    expect(visualization.every((line) => visibleWidth(line) <= 40)).toBe(true);

    const projected = renderUsageVisualization(
      {
        ...analysis,
        policyImpact: { ...analysis.policyImpact, realized: false },
      },
      false,
      40,
      theme,
    );
    expect(projected.join("\n")).toContain("projected to be saved");

    const unknownWindow = renderUsageVisualization(
      {
        ...analysis,
        model: { ...analysis.model, contextWindow: 0 },
      },
      false,
      32,
      theme,
    );
    const unknownWindowText = unknownWindow.join("\n");
    expect(unknownWindowText).toContain("Window size unavailable");
    expect(unknownWindowText.split("[Composition Bars]")[0]).not.toContain("│");

    const overflow = renderUsageVisualization(
      {
        ...analysis,
        model: { ...analysis.model, contextWindow: 10_000 },
        reported: { tokens: 9_000, percent: 90 },
        categories: {
          ...analysis.categories,
          compactionReserve: 2_000,
          freeSpace: 0,
        },
      },
      false,
      32,
      theme,
    );
    expect(overflow.join("\n")).toContain("exceed the");
    expect(overflow.join("\n")).toContain("context window");

    const narrow = renderUsageVisualization(
      {
        ...analysis,
        resources: analysis.resources.map((resource, index) =>
          index === 0
            ? { ...resource, label: "非常に長い📚コンテキスト名" }
            : resource,
        ),
      },
      true,
      24,
      theme,
    );
    expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(narrow.join("\n")).toContain(
      String(largestContextConsumers(analysis)[0]?.tokens),
    );
  });
});
