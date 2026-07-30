import {
  buildSessionContext,
  estimateTokens,
  formatSkillsForPrompt,
  getLatestCompactionEntry,
  SettingsManager,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { selectEffectiveSkills } from "./effective-context";
import { contextFilesFromOptions } from "./resources";
import { filterSkillSystemPrompt, formatSkillsSection } from "./system-prompt";
import type { ResourceItem, RuntimeConfig } from "./types";

export type ResourceVisibility =
  | "model-visible"
  | "blocked-by-policy"
  | "explicit-only"
  | "read-tool-disabled";

export interface ContextResourceUsage {
  kind: "context-file" | "skill";
  label: string;
  path: string;
  group?: string;
  visibility: ResourceVisibility;
  tokens: number;
  slashCommands: string[];
}

export interface ToolDefinitionUsage {
  name: string;
  source: string;
  tokens: number;
}

export interface MessageUsage {
  index: number;
  role: string;
  tokens: number;
  summary: string;
}

export interface ContextUsageAnalysis {
  model: {
    label: string;
    provider?: string;
    contextWindow: number;
  };
  reported: {
    tokens: number | null;
    percent: number | null;
  };
  estimated: {
    systemPrompt: number;
    toolDefinitions: number;
    conversation: number;
    total: number;
    percent: number | null;
    deltaFromReported: number | null;
  };
  categories: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    otherMessages: number;
    compactionReserve: number;
    freeSpace: number;
  };
  systemPrompt: {
    total: number;
    baseAndExtensions: number;
    contextFiles: number;
    skills: number;
    guidelines: number;
    toolSnippets: number;
    appendText: number;
    filteringComplete: boolean;
  };
  policyImpact: {
    contextFiles: { active: number; saved: number };
    skills: { active: number; saved: number };
    totalSaved: number;
    percentOfWindow: number | null;
    realized: boolean;
  };
  resources: ContextResourceUsage[];
  guidelineBullets: string[];
  toolSnippets: Array<{ name: string; tokens: number }>;
  tools: ToolDefinitionUsage[];
  messages: MessageUsage[];
  compaction: {
    active: boolean;
    summarizedMessages: number;
  };
  warnings: string[];
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatContextFileForEstimate(file: { path: string; content: string }): string {
  return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
}

function formatContextSectionForEstimate(options: BuildSystemPromptOptions): string {
  const contextFiles = options.contextFiles ?? [];
  if (contextFiles.length === 0) return "";

  return `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${contextFiles.map(formatContextFileForEstimate).join("")}</project_context>\n`;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item !== "object" || item === null) return item;
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
      return item;
    });
  } catch {
    return String(value);
  }
}

function extractGuidelines(systemPrompt: string): string {
  const marker = "\nGuidelines:\n";
  const start = systemPrompt.indexOf(marker);
  if (start < 0) return "";

  const contentStart = start + marker.length;
  const candidates = ["\n\nPi documentation", "\n\n<project_context>", "\n\nThe following skills"];
  let end = systemPrompt.length;
  for (const candidate of candidates) {
    const index = systemPrompt.indexOf(candidate, contentStart);
    if (index >= 0) end = Math.min(end, index);
  }
  return systemPrompt.slice(contentStart, end).trim();
}

function resourcePathMap<T extends { path?: string; filePath?: string }>(
  resources: T[] | undefined,
): Map<string, T> {
  return new Map(
    (resources ?? []).map((resource) => [resource.path ?? resource.filePath ?? "", resource]),
  );
}

function itemUsage(input: {
  item: ResourceItem;
  kind: "context-file" | "skill";
  visibility: ResourceVisibility;
  tokens: number;
  slashCommands?: string[];
}): ContextResourceUsage {
  return {
    kind: input.kind,
    label: input.item.ref.label ?? input.item.ref.path,
    path: input.item.ref.path,
    ...(input.item.ref.group ? { group: input.item.ref.group } : {}),
    visibility: input.visibility,
    tokens: input.tokens,
    slashCommands: input.slashCommands ?? [],
  };
}

function summarizeMessage(message: unknown): { role: string; summary: string } {
  if (!message || typeof message !== "object") {
    return { role: "other", summary: "Unknown message" };
  }
  const record = message as { role?: string; content?: unknown };
  const role = record.role ?? "other";
  let text = "";
  if (typeof record.content === "string") {
    text = record.content;
  } else if (Array.isArray(record.content)) {
    text = record.content
      .flatMap((block: unknown) => {
        if (!block || typeof block !== "object") return [];
        const value = block as {
          type?: string;
          text?: string;
          thinking?: string;
          name?: string;
        };
        if (value.type === "text" && value.text) return [value.text];
        if (value.type === "thinking" && value.thinking) return [`thinking: ${value.thinking}`];
        if (value.type === "toolCall" && value.name) return [`tool: ${value.name}`];
        return [];
      })
      .join(" ");
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return {
    role,
    summary: normalized.length > 0 ? normalized.slice(0, 100) : `${role} message`,
  };
}

function assistantToolTokens(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content as unknown[]) {
    if (!block || typeof block !== "object") continue;
    const value = block as {
      type?: string;
      name?: string;
      arguments?: unknown;
    };
    if (value.type !== "toolCall") continue;
    total += estimateTextTokens(`${value.name ?? ""}${safeStringify(value.arguments)}`);
  }
  return total;
}

function messageTokenEstimate(message: Parameters<typeof estimateTokens>[0]): number {
  try {
    return estimateTokens(message);
  } catch {
    return estimateTextTokens(safeStringify(message));
  }
}

function collectConversation(ctx: ExtensionCommandContext): {
  messages: MessageUsage[];
  categories: Pick<
    ContextUsageAnalysis["categories"],
    "userMessages" | "assistantMessages" | "toolCalls" | "toolResults" | "otherMessages"
  >;
  total: number;
  compaction: ContextUsageAnalysis["compaction"];
} {
  const branch = ctx.sessionManager.getBranch();
  const sessionContext = buildSessionContext(branch);
  const categories = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    otherMessages: 0,
  };
  const messages = sessionContext.messages.map((message, index) => {
    const tokens = messageTokenEstimate(message);
    const { role, summary } = summarizeMessage(message);

    if (role === "user") {
      categories.userMessages += tokens;
    } else if (role === "assistant") {
      const toolTokens = Math.min(tokens, assistantToolTokens(message));
      categories.toolCalls += toolTokens;
      categories.assistantMessages += tokens - toolTokens;
    } else if (role === "toolResult") {
      categories.toolResults += tokens;
    } else {
      categories.otherMessages += tokens;
    }

    return { index: index + 1, role, tokens, summary };
  });

  const compactionEntry = getLatestCompactionEntry(branch);
  const firstKeptIndex = compactionEntry
    ? branch.findIndex((entry) => entry.id === compactionEntry.firstKeptEntryId)
    : -1;
  const summarizedMessages =
    firstKeptIndex <= 0
      ? 0
      : branch
          .slice(0, firstKeptIndex)
          .filter((entry) => ["message", "custom_message"].includes(entry.type)).length;

  return {
    messages,
    categories,
    total: messages.reduce((sum, message) => sum + message.tokens, 0),
    compaction: {
      active: Boolean(compactionEntry),
      summarizedMessages,
    },
  };
}

function collectTools(pi: ExtensionAPI): {
  tools: ToolDefinitionUsage[];
  total: number;
  warnings: string[];
} {
  const activeNames = new Set(pi.getActiveTools());
  const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  const warnings: string[] = [];
  const tools: ToolDefinitionUsage[] = [];

  for (const name of activeNames) {
    const tool = toolsByName.get(name);
    if (!tool) {
      warnings.push(`Active tool ${name} has no registered definition metadata.`);
      continue;
    }
    const serialized = safeStringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
    tools.push({
      name: tool.name,
      source: tool.sourceInfo.source,
      tokens: estimateTextTokens(serialized),
    });
  }
  tools.sort((left, right) => right.tokens - left.tokens);

  return {
    tools,
    total: tools.reduce((sum, tool) => sum + tool.tokens, 0),
    warnings,
  };
}

function commandMap(pi: ExtensionAPI): Map<string, string[]> {
  const commands = new Map<string, string[]>();
  for (const command of pi.getCommands()) {
    if (command.source !== "skill") continue;
    const names = commands.get(command.sourceInfo.path) ?? [];
    names.push(`/${command.name}`);
    commands.set(command.sourceInfo.path, names);
  }
  return commands;
}

function skillTokens(skill: Skill | undefined): number {
  if (!skill) return 0;
  const manifest = formatSkillsForPrompt([skill]);
  const match = /<available_skills>\n([\s\S]+)\n<\/available_skills>/.exec(manifest);
  return estimateTextTokens(match?.[1] ?? manifest);
}

export async function analyzeContextUsage(input: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  runtime: RuntimeConfig;
  options: BuildSystemPromptOptions;
  compactionReserveTokens?: number;
}): Promise<ContextUsageAnalysis> {
  const { pi, ctx, runtime, options } = input;
  const selection = await selectEffectiveSkills(options, runtime);
  const promptProjection = filterSkillSystemPrompt({
    currentSystemPrompt: ctx.getSystemPrompt(),
    baseOptions: options,
    filteredOptions: selection.effectiveOptions,
  });
  const effectivePrompt = promptProjection.systemPrompt;
  const contextByPath = resourcePathMap(options.contextFiles);
  const skillByPath = resourcePathMap(options.skills);
  const slashCommands = commandMap(pi);
  const resources: ContextResourceUsage[] = [];

  for (const item of await contextFilesFromOptions(options, runtime.repository)) {
    const contextFile = contextByPath.get(item.sourcePath);
    resources.push(
      itemUsage({
        item,
        kind: "context-file",
        visibility: "model-visible",
        tokens: contextFile ? estimateTextTokens(formatContextFileForEstimate(contextFile)) : 0,
      }),
    );
  }

  const readEnabled = options.selectedTools === undefined || options.selectedTools.includes("read");
  for (const item of selection.enabled) {
    const skill = skillByPath.get(item.sourcePath);
    resources.push(
      itemUsage({
        item,
        kind: "skill",
        visibility: readEnabled ? "model-visible" : "read-tool-disabled",
        tokens: readEnabled ? skillTokens(skill) : 0,
        slashCommands: slashCommands.get(item.sourcePath) ?? [],
      }),
    );
  }
  for (const item of selection.blocked) {
    resources.push(
      itemUsage({
        item,
        kind: "skill",
        visibility: "blocked-by-policy",
        tokens: skillTokens(skillByPath.get(item.sourcePath)),
        slashCommands: slashCommands.get(item.sourcePath) ?? [],
      }),
    );
  }
  for (const item of selection.explicitOnly) {
    resources.push(
      itemUsage({
        item,
        kind: "skill",
        visibility: "explicit-only",
        tokens: 0,
        slashCommands: slashCommands.get(item.sourcePath) ?? [],
      }),
    );
  }

  const systemPromptTokens = estimateTextTokens(effectivePrompt);
  const expectedContextSection = formatContextSectionForEstimate(options);
  const expectedSkillSection = formatSkillsSection(selection.effectiveOptions);
  const contextSectionTokens = estimateTextTokens(expectedContextSection);
  const skillSectionTokens = estimateTextTokens(expectedSkillSection);
  const unfilteredSkillTokens = estimateTextTokens(formatSkillsSection(options));
  const savedContextTokens = 0;
  const savedSkillTokens = Math.max(0, unfilteredSkillTokens - skillSectionTokens);
  const totalSavedTokens = savedSkillTokens;
  const projectedSkillSectionPresent =
    expectedSkillSection.length === 0 || effectivePrompt.includes(expectedSkillSection);
  const filteringComplete = promptProjection.recognizedSkillSection && projectedSkillSectionPresent;
  const guidelinesText = extractGuidelines(effectivePrompt);
  const guidelineBullets = guidelinesText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
  const guidelinesTokens = estimateTextTokens(guidelinesText);
  const includedToolSnippets: Record<string, string> = selection.effectiveOptions.customPrompt
    ? {}
    : Object.fromEntries(
        Object.entries(selection.effectiveOptions.toolSnippets ?? {}).filter(([, snippet]) =>
          effectivePrompt.includes(snippet),
        ),
      );
  const toolSnippets = Object.entries(includedToolSnippets)
    .map(([name, snippet]) => ({
      name,
      tokens: estimateTextTokens(snippet),
    }))
    .sort((left, right) => right.tokens - left.tokens);
  const toolSnippetTokens = estimateTextTokens(Object.values(includedToolSnippets).join("\n"));
  const appendText = selection.effectiveOptions.appendSystemPrompt ?? "";
  const appendTokens =
    appendText.length > 0 && effectivePrompt.includes(appendText)
      ? estimateTextTokens(appendText)
      : 0;
  const knownPromptTokens =
    contextSectionTokens + skillSectionTokens + guidelinesTokens + toolSnippetTokens + appendTokens;

  const conversation = collectConversation(ctx);
  const toolDefinitions = collectTools(pi);
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const estimatedTotal = systemPromptTokens + toolDefinitions.total + conversation.total;
  const reportedTokens = usage?.tokens ?? null;
  const usedForFreeSpace = reportedTokens ?? estimatedTotal;
  const compactionReserve =
    input.compactionReserveTokens ??
    (() => {
      if (contextWindow <= 0) return 0;
      const settings = SettingsManager.create(ctx.cwd, undefined, {
        projectTrusted: ctx.isProjectTrusted(),
      }).getCompactionSettings();
      return settings.enabled ? settings.reserveTokens : 0;
    })();
  const warnings = [...toolDefinitions.warnings];
  if (!filteringComplete) {
    warnings.push(
      "Some skill paths remain outside Pi's recognized generated section; skill-policy projection may be incomplete.",
    );
  }
  if (!usage) {
    warnings.push("Pi has no provider usage data for this session yet.");
  } else if (usage.tokens === null) {
    warnings.push("Pi's current token count is pending; the snapshot total is estimated.");
  }

  return {
    model: {
      label: ctx.model?.name ?? ctx.model?.id ?? "No model selected",
      ...(ctx.model?.provider ? { provider: ctx.model.provider } : {}),
      contextWindow,
    },
    reported: {
      tokens: reportedTokens,
      percent: usage?.percent ?? null,
    },
    estimated: {
      systemPrompt: systemPromptTokens,
      toolDefinitions: toolDefinitions.total,
      conversation: conversation.total,
      total: estimatedTotal,
      percent: contextWindow > 0 ? (estimatedTotal / contextWindow) * 100 : null,
      deltaFromReported: reportedTokens === null ? null : estimatedTotal - reportedTokens,
    },
    categories: {
      ...conversation.categories,
      compactionReserve,
      freeSpace: Math.max(0, contextWindow - usedForFreeSpace - compactionReserve),
    },
    systemPrompt: {
      total: systemPromptTokens,
      baseAndExtensions: Math.max(0, systemPromptTokens - knownPromptTokens),
      contextFiles: contextSectionTokens,
      skills: skillSectionTokens,
      guidelines: guidelinesTokens,
      toolSnippets: toolSnippetTokens,
      appendText: appendTokens,
      filteringComplete,
    },
    policyImpact: {
      contextFiles: {
        active: contextSectionTokens,
        saved: savedContextTokens,
      },
      skills: {
        active: skillSectionTokens,
        saved: savedSkillTokens,
      },
      totalSaved: totalSavedTokens,
      percentOfWindow: contextWindow > 0 ? (totalSavedTokens / contextWindow) * 100 : null,
      realized: filteringComplete,
    },
    resources,
    guidelineBullets,
    toolSnippets,
    tools: toolDefinitions.tools,
    messages: conversation.messages,
    compaction: conversation.compaction,
    warnings,
  };
}
