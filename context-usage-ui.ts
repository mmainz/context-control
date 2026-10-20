import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import type { ContextResourceUsage, ContextUsageAnalysis } from "./context-usage";

function formatTokens(tokens: number | null): string {
  if (tokens === null) return "pending";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatPercent(percent: number | null): string {
  if (percent === null) return "n/a";
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(1)}%`;
}

function formatWindowShare(tokens: number, contextWindow: number): string {
  return contextWindow > 0 ? formatPercent((tokens / contextWindow) * 100) : "n/a";
}

interface BarSegment {
  label: string;
  value: number;
  glyph: string;
  color: ThemeColor;
}

export interface ContextConsumer {
  kind: "context-file" | "skill" | "tool" | "message";
  label: string;
  tokens: number;
}

export function allocateBarWidths(values: number[], total: number, width: number): number[] {
  if (width <= 0 || total <= 0) return values.map(() => 0);
  const normalized = values.map((value) => Math.max(0, value));
  if (normalized.every((value) => value === 0)) return values.map(() => 0);
  const raw = normalized.map((value) => (value / total) * width);
  const result = raw.map(Math.floor);
  let remaining = width - result.reduce((sum, value) => sum + value, 0);
  const remainderOrder = raw
    .map((value, index) => ({
      index,
      remainder: value - Math.floor(value),
      positive: (normalized[index] ?? 0) > 0,
    }))
    .filter((item) => item.positive)
    .sort((left, right) => right.remainder - left.remainder);
  for (const item of remainderOrder) {
    if (remaining <= 0) break;
    result[item.index] = (result[item.index] ?? 0) + 1;
    remaining -= 1;
  }

  for (let index = 0; index < normalized.length; index += 1) {
    if ((normalized[index] ?? 0) <= 0 || (result[index] ?? 0) > 0) continue;
    const donor = result
      .map((value, donorIndex) => ({ donorIndex, value }))
      .filter((item) => item.value > 1)
      .sort((left, right) => right.value - left.value)[0];
    if (!donor) break;
    result[donor.donorIndex] = (result[donor.donorIndex] ?? 0) - 1;
    result[index] = 1;
  }

  return result;
}

export function largestContextConsumers(
  analysis: ContextUsageAnalysis,
  limit = 10,
): ContextConsumer[] {
  const resources: ContextConsumer[] = analysis.resources
    .filter((resource) => resource.visibility === "model-visible" && resource.tokens > 0)
    .map((resource) => ({
      kind: resource.kind,
      label: resource.label,
      tokens: resource.tokens,
    }));
  const tools: ContextConsumer[] = analysis.tools
    .filter((tool) => tool.tokens > 0)
    .map((tool) => ({ kind: "tool", label: tool.name, tokens: tool.tokens }));
  const messages: ContextConsumer[] = analysis.messages
    .filter((message) => message.tokens > 0)
    .map((message) => ({
      kind: "message",
      label: `${message.role} #${message.index}: ${message.summary}`,
      tokens: message.tokens,
    }));

  return [...resources, ...tools, ...messages]
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, limit);
}

function resourceLabel(resource: ContextResourceUsage): string {
  const commands =
    resource.slashCommands.length > 0 ? ` · ${resource.slashCommands.join(", ")}` : "";
  const tokenLabel =
    resource.visibility === "blocked-by-policy"
      ? `~${formatTokens(resource.tokens)} tokens if enabled`
      : resource.visibility === "explicit-only" || resource.visibility === "read-tool-disabled"
        ? "0 automatic tokens"
        : `~${formatTokens(resource.tokens)} tokens`;
  return `${resource.label} · ${tokenLabel}${commands}`;
}

function pushResourceSection(
  lines: string[],
  title: string,
  resources: ContextResourceUsage[],
): void {
  lines.push(`[${title}]`);
  if (resources.length === 0) {
    lines.push("  (none)", "");
    return;
  }
  for (const resource of resources) {
    lines.push(`  ${resourceLabel(resource)}`);
    lines.push(`    ${resource.path}`);
  }
  lines.push("");
}

export function formatContextUsageLines(analysis: ContextUsageAnalysis, full: boolean): string[] {
  const lines: string[] = [
    "[Context Usage]",
    `  Model: ${analysis.model.provider ? `${analysis.model.provider}/` : ""}${analysis.model.label}`,
    `  Context window: ${formatTokens(analysis.model.contextWindow)} tokens`,
    `  Pi-reported usage: ${formatTokens(analysis.reported.tokens)} (${formatPercent(analysis.reported.percent)})`,
    `  Estimated snapshot: ${formatTokens(analysis.estimated.total)} (${formatPercent(analysis.estimated.percent)})`,
    "",
  ];

  if (full) {
    lines.push(
      "[Estimated Composition]",
      `  System prompt: ${formatTokens(analysis.estimated.systemPrompt)}`,
      `  Active tool definitions: ${formatTokens(analysis.estimated.toolDefinitions)}`,
      `  Conversation: ${formatTokens(analysis.estimated.conversation)}`,
      `    User messages: ${formatTokens(analysis.categories.userMessages)}`,
      `    Assistant messages: ${formatTokens(analysis.categories.assistantMessages)}`,
      `    Tool calls: ${formatTokens(analysis.categories.toolCalls)}`,
      `    Tool results: ${formatTokens(analysis.categories.toolResults)}`,
      `    Other messages: ${formatTokens(analysis.categories.otherMessages)}`,
      `  Compaction reserve: ${formatTokens(analysis.categories.compactionReserve)}`,
      "",
    );
  }

  const visibleContext = analysis.resources.filter(
    (resource) => resource.kind === "context-file" && resource.visibility === "model-visible",
  );
  const visibleSkills = analysis.resources.filter(
    (resource) => resource.kind === "skill" && resource.visibility === "model-visible",
  );
  const blocked = analysis.resources.filter(
    (resource) => resource.visibility === "blocked-by-policy",
  );
  const explicitOnly = analysis.resources.filter(
    (resource) => resource.visibility === "explicit-only",
  );
  const readDisabled = analysis.resources.filter(
    (resource) => resource.visibility === "read-tool-disabled",
  );

  lines.push(
    "[Effective Resources]",
    `  Model-visible context files: ${visibleContext.length}`,
    `  Model-visible skills: ${visibleSkills.length}`,
    `  Blocked by skill policy: ${blocked.length}`,
    `  Explicit-only skills: ${explicitOnly.length}`,
    `  Skills hidden because no file reader is active: ${readDisabled.length}`,
    "  Slash commands are shown separately from automatic model visibility.",
    "",
    "[Skill Policy Impact]",
    `  Instruction/context files: ${formatTokens(analysis.policyImpact.contextFiles.active)} active (${formatWindowShare(analysis.policyImpact.contextFiles.active, analysis.model.contextWindow)} of window) · Pi-managed`,
    `  Skill manifest: ${formatTokens(analysis.policyImpact.skills.active)} active (${formatWindowShare(analysis.policyImpact.skills.active, analysis.model.contextWindow)} of window) · ${formatTokens(analysis.policyImpact.skills.saved)} saved (${formatWindowShare(analysis.policyImpact.skills.saved, analysis.model.contextWindow)} of window)`,
    `  ${analysis.policyImpact.realized ? "Total saved by" : "Projected savings from"} skill policy: ${formatTokens(analysis.policyImpact.totalSaved)} (${formatPercent(analysis.policyImpact.percentOfWindow)} of window)`,
    "",
  );

  if (!full) {
    if (analysis.warnings.length > 0) {
      lines.push("[Warnings]");
      for (const warning of analysis.warnings) lines.push(`  ! ${warning}`);
      lines.push("");
    }
    lines.push(
      "Component values are estimates; Pi's reported total is authoritative when available.",
    );
    return lines;
  }

  lines.push(
    "[System Prompt Breakdown]",
    `  Base, custom text, and extensions: ${formatTokens(analysis.systemPrompt.baseAndExtensions)}`,
    `  Context-file section: ${formatTokens(analysis.systemPrompt.contextFiles)}`,
    `  Skill manifest: ${formatTokens(analysis.systemPrompt.skills)}`,
    `  Guidelines: ${formatTokens(analysis.systemPrompt.guidelines)}`,
    `  Tool snippets: ${formatTokens(analysis.systemPrompt.toolSnippets)}`,
    `  Appended text: ${formatTokens(analysis.systemPrompt.appendText)}`,
    `  Skill filtering identified completely: ${analysis.systemPrompt.filteringComplete ? "yes" : "no"}`,
    "",
  );

  lines.push("[Guidelines]");
  if (analysis.guidelineBullets.length === 0) {
    lines.push("  (none detected)");
  } else {
    for (const guideline of analysis.guidelineBullets) {
      lines.push(`  - ${guideline}`);
    }
  }
  lines.push("");

  lines.push("[Tool Snippets]");
  if (analysis.toolSnippets.length === 0) {
    lines.push("  (none)");
  } else {
    for (const snippet of analysis.toolSnippets) {
      lines.push(`  ${snippet.name} · ~${formatTokens(snippet.tokens)} tokens`);
    }
  }
  lines.push("");

  pushResourceSection(lines, "Model-visible Context Files", visibleContext);
  pushResourceSection(lines, "Model-visible Skills", visibleSkills);
  pushResourceSection(lines, "Blocked Resources", blocked);
  pushResourceSection(lines, "Explicit-only Skills", explicitOnly);
  pushResourceSection(lines, "Reader-disabled Skills", readDisabled);

  lines.push("[Active Tool Definitions]");
  if (analysis.tools.length === 0) {
    lines.push("  (none)");
  } else {
    for (const tool of analysis.tools) {
      lines.push(`  ${tool.name} · ${tool.source} · ~${formatTokens(tool.tokens)} tokens`);
    }
  }
  lines.push("");

  lines.push("[Compaction-aware Conversation]");
  if (analysis.messages.length === 0) {
    lines.push("  (no model-visible messages)");
  } else {
    for (const message of analysis.messages) {
      lines.push(`  ${message.index}. ${message.role} · ~${formatTokens(message.tokens)} tokens`);
      lines.push(`    ${message.summary}`);
    }
  }
  lines.push("");

  lines.push(
    "[Compaction]",
    `  Active summary: ${analysis.compaction.active ? "yes" : "no"}`,
    `  Messages before latest summary: ${analysis.compaction.summarizedMessages}`,
    "",
  );

  if (analysis.estimated.deltaFromReported !== null) {
    const delta = analysis.estimated.deltaFromReported;
    lines.push(
      "[Estimate Difference]",
      `  Snapshot minus Pi-reported usage: ${delta >= 0 ? "+" : ""}${formatTokens(delta)} tokens`,
      "  Differences come from provider tokenization, schema serialization, and snapshot timing.",
      "",
    );
  }

  if (analysis.warnings.length > 0) {
    lines.push("[Warnings]");
    for (const warning of analysis.warnings) lines.push(`  ! ${warning}`);
    lines.push("");
  }

  lines.push(
    "[Method]",
    "  Pi-reported usage is the authoritative headline when available.",
    "  Message estimates use Pi's public estimator; text and schema components use approximately four characters per token.",
    "  Blocked and explicit-only resources contribute zero to current automatic model context.",
  );
  return lines;
}

function styleLine(line: string, theme: Theme): string {
  if (/^\[[^\]]+\]$/.test(line)) {
    return theme.fg("accent", theme.bold(line));
  }
  if (line.startsWith("  ! ")) return theme.fg("warning", line);
  if (line.startsWith("    ")) return theme.fg("dim", line);
  if (line.startsWith("  ")) return theme.fg("muted", line);
  return theme.fg("dim", line);
}

function overallSegments(analysis: ContextUsageAnalysis): {
  segments: BarSegment[];
  total: number;
  overflow: number;
} {
  const reportedUsed = analysis.reported.tokens ?? analysis.estimated.total;
  const knownUsed = Math.max(1, analysis.estimated.total);
  const total = Math.max(0, analysis.model.contextWindow);
  const inWindowUsed = Math.min(reportedUsed, total);
  const scale = Math.min(1, inWindowUsed / knownUsed);
  const prompt = analysis.estimated.systemPrompt * scale;
  const tools = analysis.estimated.toolDefinitions * scale;
  const conversation = analysis.estimated.conversation * scale;
  const variance = Math.max(0, inWindowUsed - knownUsed);
  const requestedReserve = analysis.categories.compactionReserve;
  const reserve = Math.min(requestedReserve, Math.max(0, total - inWindowUsed));
  const free = Math.max(0, total - inWindowUsed - reserve);
  const overflow = Math.max(0, reportedUsed + requestedReserve - total);

  return {
    total,
    overflow,
    segments: [
      {
        label: "prompt",
        value: prompt,
        glyph: "█",
        color: "accent",
      },
      {
        label: "tools",
        value: tools,
        glyph: "▓",
        color: "toolTitle",
      },
      {
        label: "chat",
        value: conversation,
        glyph: "▒",
        color: "success",
      },
      {
        label: "unattributed",
        value: variance,
        glyph: "◆",
        color: "warning",
      },
      {
        label: "reserve",
        value: reserve,
        glyph: "░",
        color: "muted",
      },
      {
        label: "free",
        value: free,
        glyph: "·",
        color: "dim",
      },
    ],
  };
}

function renderSegmentedBar(
  segments: BarSegment[],
  total: number,
  width: number,
  theme: Theme,
): string {
  const barWidth = Math.max(8, Math.min(72, width - 4));
  const segmentWidths = allocateBarWidths(
    segments.map((segment) => segment.value),
    total,
    barWidth,
  );
  const content = segments
    .map((segment, index) =>
      theme.fg(segment.color, segment.glyph.repeat(segmentWidths[index] ?? 0)),
    )
    .join("");
  return truncateToWidth(`${theme.fg("border", "│")}${content}${theme.fg("border", "│")}`, width);
}

function renderLegend(segments: BarSegment[], width: number, theme: Theme): string[] {
  const visible = segments.filter((segment) => segment.value > 0);
  const groups = [visible.slice(0, 4), visible.slice(4)].filter((group) => group.length > 0);
  return groups.flatMap((group) => {
    const legend = group
      .map(
        (segment) =>
          `${theme.fg(segment.color, segment.glyph === "·" ? "·" : "■")} ${segment.label}`,
      )
      .join(theme.fg("dim", " · "));
    return wrapTextWithAnsi(legend, Math.max(1, width - 2)).map((line) => `  ${line}`);
  });
}

function padToVisibleWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function indentWrapped(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width - 2)).map((line) => `  ${line}`);
}

function renderCategoryBar(input: {
  label: string;
  value: number;
  total: number;
  color: ThemeColor;
  width: number;
  theme: Theme;
}): string[] {
  const percent = input.total > 0 ? (input.value / input.total) * 100 : 0;
  const valueLabel = `${formatTokens(input.value)}  ${percent.toFixed(0)}%`;
  if (input.width < 46) {
    const metricWidth = valueLabel.length;
    const labelWidth = Math.max(1, input.width - metricWidth - 3);
    const label = truncateToWidth(input.label, labelWidth);
    const barWidth = Math.max(1, input.width - metricWidth - 3);
    const fill = Math.round((Math.min(100, percent) / 100) * barWidth);
    return [
      truncateToWidth(`  ${padToVisibleWidth(label, labelWidth)} ${valueLabel}`, input.width),
      truncateToWidth(
        `  ${input.theme.fg(input.color, "█".repeat(fill))}${input.theme.fg("dim", "░".repeat(barWidth - fill))} ${valueLabel}`,
        input.width,
      ),
    ];
  }

  const labelWidth = 14;
  const valueWidth = Math.max(9, valueLabel.length);
  const barWidth = Math.max(8, Math.min(30, input.width - labelWidth - valueWidth - 5));
  const fill = Math.round((Math.min(100, percent) / 100) * barWidth);
  const line = `  ${input.label.padEnd(labelWidth)} ${input.theme.fg(input.color, "█".repeat(fill))}${input.theme.fg("dim", "░".repeat(barWidth - fill))} ${valueLabel.padStart(valueWidth)}`;
  return [truncateToWidth(line, input.width)];
}

function renderPolicyImpact(analysis: ContextUsageAnalysis, width: number, theme: Theme): string[] {
  const rows = [
    {
      label: "Instruction/context files",
      active: analysis.policyImpact.contextFiles.active,
      saved: analysis.policyImpact.contextFiles.saved,
      color: "accent" as ThemeColor,
    },
    {
      label: "Skill manifest",
      active: analysis.policyImpact.skills.active,
      saved: analysis.policyImpact.skills.saved,
      color: "toolTitle" as ThemeColor,
    },
  ];
  const impactColor: ThemeColor = analysis.policyImpact.realized
    ? analysis.policyImpact.totalSaved > 0
      ? "success"
      : "muted"
    : "warning";
  const lines = [
    styleLine("[Resource Footprint]", theme),
    ...indentWrapped(
      theme.fg(
        impactColor,
        `${formatTokens(analysis.policyImpact.totalSaved)} tokens ${analysis.policyImpact.realized ? "saved" : "projected to be saved"} by skill policy · ${formatPercent(analysis.policyImpact.percentOfWindow)} of the context window`,
      ),
      width,
    ),
  ];

  for (const row of rows) {
    const total = row.active + row.saved;
    lines.push(theme.fg("muted", `  ${row.label}`));
    if (total <= 0) {
      lines.push(theme.fg("dim", "  (no automatic context)"));
      continue;
    }
    const bar = renderSegmentedBar(
      [
        {
          label: "active",
          value: row.active,
          glyph: "█",
          color: row.color,
        },
        {
          label: "saved",
          value: row.saved,
          glyph: "░",
          color: analysis.policyImpact.realized ? "success" : "warning",
        },
      ],
      total,
      Math.max(1, width - 2),
      theme,
    );
    lines.push(`  ${bar}`);
    lines.push(
      ...indentWrapped(
        `${formatTokens(row.active)} active (${formatWindowShare(row.active, analysis.model.contextWindow)} of window) · ${formatTokens(row.saved)} ${analysis.policyImpact.realized ? "saved" : "projected"} (${formatWindowShare(row.saved, analysis.model.contextWindow)} of window)`,
        width,
      ),
    );
  }
  lines.push("");
  return lines;
}

function consumerColor(consumer: ContextConsumer): ThemeColor {
  if (consumer.kind === "context-file") return "accent";
  if (consumer.kind === "skill") return "success";
  if (consumer.kind === "tool") return "toolTitle";
  return "userMessageText";
}

function consumerKindLabel(consumer: ContextConsumer): string {
  if (consumer.kind === "context-file") return "file";
  if (consumer.kind === "message") return "msg";
  return consumer.kind;
}

function renderConsumerHeatmap(
  analysis: ContextUsageAnalysis,
  width: number,
  theme: Theme,
): string[] {
  const consumers = largestContextConsumers(analysis);
  const lines = [styleLine("[Largest Context Consumers]", theme)];
  if (consumers.length === 0) {
    lines.push(theme.fg("muted", "  (no estimated consumers)"), "");
    return lines;
  }

  const maximum = Math.max(...consumers.map((consumer) => consumer.tokens), 1);
  const barWidth = Math.max(6, Math.min(24, width - 34));
  for (const consumer of consumers) {
    const color = consumerColor(consumer);
    const fill = Math.max(1, Math.round((consumer.tokens / maximum) * barWidth));
    const kind = consumerKindLabel(consumer);
    if (width < 54) {
      const tokenLabel = formatTokens(consumer.tokens);
      const narrowBarWidth = Math.max(1, Math.min(24, width - tokenLabel.length - 4));
      const narrowFill = Math.max(1, Math.round((consumer.tokens / maximum) * narrowBarWidth));
      lines.push(
        truncateToWidth(`  [${kind}] ${consumer.label}`, width),
        truncateToWidth(
          `  ${theme.fg(color, "█".repeat(narrowFill))}${theme.fg("dim", "░".repeat(narrowBarWidth - narrowFill))} ${tokenLabel}`,
          width,
        ),
      );
      continue;
    }
    const labelWidth = Math.max(12, width - barWidth - 14);
    const label = truncateToWidth(`[${kind}] ${consumer.label}`, labelWidth);
    lines.push(
      truncateToWidth(
        `  ${padToVisibleWidth(label, labelWidth)} ${theme.fg(color, "█".repeat(fill))}${theme.fg("dim", "░".repeat(barWidth - fill))} ${formatTokens(consumer.tokens).padStart(6)}`,
        width,
      ),
    );
  }
  lines.push("");
  return lines;
}

export function renderUsageVisualization(
  analysis: ContextUsageAnalysis,
  full: boolean,
  width: number,
  theme: Theme,
): string[] {
  const { segments, total, overflow } = overallSegments(analysis);
  const used = analysis.reported.tokens ?? analysis.estimated.total;
  const windowLines =
    total <= 0
      ? indentWrapped(
          theme.fg("warning", "Window size unavailable; pressure cannot be mapped."),
          width,
        )
      : [
          ...indentWrapped(
            theme.fg(
              "muted",
              `${formatTokens(used)} used · ${formatTokens(analysis.categories.compactionReserve)} reserve · ${formatTokens(analysis.categories.freeSpace)} free`,
            ),
            width,
          ),
          renderSegmentedBar(segments, total, width, theme),
          ...renderLegend(segments, width, theme),
          ...(overflow > 0
            ? indentWrapped(
                theme.fg(
                  "error",
                  `! ${formatTokens(overflow)} tokens exceed the context window after reserve.`,
                ),
                width,
              )
            : []),
          ...indentWrapped(
            theme.fg(
              "dim",
              "Window pressure uses Pi's total; composition uses the estimated snapshot.",
            ),
            width,
          ),
        ];
  const lines = [
    styleLine("[Context Window Map]", theme),
    ...windowLines,
    "",
    styleLine("[Composition Bars]", theme),
    ...renderCategoryBar({
      label: "System prompt",
      value: analysis.estimated.systemPrompt,
      total: analysis.estimated.total,
      color: "accent",
      width,
      theme,
    }),
    ...renderCategoryBar({
      label: "Conversation",
      value: analysis.estimated.conversation,
      total: analysis.estimated.total,
      color: "success",
      width,
      theme,
    }),
    ...renderCategoryBar({
      label: "Tools",
      value: analysis.estimated.toolDefinitions,
      total: analysis.estimated.total,
      color: "toolTitle",
      width,
      theme,
    }),
    "",
    ...renderPolicyImpact(analysis, width, theme),
  ];
  if (full) lines.push(...renderConsumerHeatmap(analysis, width, theme));
  return lines.flatMap((line) => (line.length === 0 ? [""] : wrapTextWithAnsi(line, width)));
}

export async function showContextUsage(
  ctx: ExtensionCommandContext,
  analysis: ContextUsageAnalysis,
  initialFull: boolean,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    let full = initialFull;
    let scroll = 0;
    const renderCache = new Map<string, string[]>();

    function renderedLines(width: number): string[] {
      const cacheKey = `${width}:${full ? "full" : "summary"}`;
      const cached = renderCache.get(cacheKey);
      if (cached) return cached;

      const reportLines = formatContextUsageLines(analysis, full);
      const visualizationIndex = reportLines.indexOf(
        full ? "[Estimated Composition]" : "[Effective Resources]",
      );
      const beforeVisualization = reportLines.slice(
        0,
        visualizationIndex < 0 ? reportLines.length : visualizationIndex,
      );
      const afterVisualization =
        visualizationIndex < 0 ? [] : reportLines.slice(visualizationIndex);
      const renderReportLines = (lines: string[]) =>
        lines.flatMap((line) => {
          if (line.length === 0) return [""];
          return wrapTextWithAnsi(styleLine(line, theme), width);
        });

      const rendered = [
        ...renderReportLines(beforeVisualization),
        ...renderUsageVisualization(analysis, full, width, theme),
        ...renderReportLines(afterVisualization),
      ];
      renderCache.set(cacheKey, rendered);
      return rendered;
    }

    return {
      invalidate() {
        renderCache.clear();
      },
      handleInput(data: string) {
        const pageSize = Math.max(4, tui.terminal.rows - 6);
        if (
          keybindings.matches(data, "tui.select.cancel") ||
          keybindings.matches(data, "tui.select.confirm")
        ) {
          done();
          return;
        }
        if (data === "f") {
          full = !full;
          scroll = 0;
          renderCache.clear();
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.up")) scroll = Math.max(0, scroll - 1);
        if (keybindings.matches(data, "tui.select.down")) scroll += 1;
        if (keybindings.matches(data, "tui.select.pageUp")) scroll = Math.max(0, scroll - pageSize);
        if (keybindings.matches(data, "tui.select.pageDown")) scroll += pageSize;
        tui.requestRender();
      },
      render(width: number): string[] {
        const lines = renderedLines(width);
        const pageSize = Math.max(4, tui.terminal.rows - 6);
        const maxScroll = Math.max(0, lines.length - pageSize);
        scroll = Math.min(scroll, maxScroll);
        const scrollKeys = [
          ...keybindings.getKeys("tui.select.up"),
          ...keybindings.getKeys("tui.select.down"),
          ...keybindings.getKeys("tui.select.pageUp"),
          ...keybindings.getKeys("tui.select.pageDown"),
        ].join("/");
        const closeKeys = [
          ...keybindings.getKeys("tui.select.confirm"),
          ...keybindings.getKeys("tui.select.cancel"),
        ].join("/");
        const footer = truncateToWidth(
          theme.fg(
            "dim",
            `${scrollKeys} scroll · f ${full ? "summary" : "full details"} · ${closeKeys} close`,
          ),
          width,
        );
        return [...lines.slice(scroll, scroll + pageSize), footer];
      },
    };
  });
}
