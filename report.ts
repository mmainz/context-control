import { Text, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { applyResourcePolicy, staleRefs } from "./filtering";
import type { ResourceItem, ResourcePolicy } from "./types";

interface ResourceReport {
  policy: ResourcePolicy;
  enabled: string[];
  ignored: string[];
  stale: string[];
  total: number;
}

interface ContextControlReport {
  repository: string;
  contextFiles: ResourceReport;
  skills: ResourceReport;
  configPath: string;
}

function policySummary(policy: ResourcePolicy): string {
  switch (policy.mode) {
    case "all":
      return "use all";
    case "none":
      return "use none";
    case "blocklist":
      return `block ${policy.refs.length}`;
    case "allowlist":
      return `allow ${policy.refs.length}`;
  }
}

function displayName(item: ResourceItem): string {
  return item.ref.label ?? item.ref.path;
}

function displayRefPath(path: string): string {
  return path
    .replace(/^.*\/\.agents\//, ".agents/")
    .replace(/^.*\/\.pi\//, ".pi/");
}

function displayStaleRef(ref: { label?: string; path: string }): string {
  return ref.label ?? displayRefPath(ref.path);
}

function makeResourceReport(
  items: ResourceItem[],
  policy: ResourcePolicy,
): ResourceReport {
  const enabledItems = applyResourcePolicy(items, policy);
  const enabledIds = new Set(enabledItems.map((item) => item.ref.id));

  return {
    policy,
    enabled: enabledItems.map(displayName),
    ignored: items
      .filter((item) => !enabledIds.has(item.ref.id))
      .map(displayName),
    stale: staleRefs(items, policy).map(displayStaleRef),
    total: items.length,
  };
}

export function makeContextControlReport(input: {
  repository: string;
  contextFileItems: ResourceItem[];
  skillItems: ResourceItem[];
  contextPolicy: ResourcePolicy;
  skillPolicy: ResourcePolicy;
  configPath: string;
}): ContextControlReport {
  return {
    repository: input.repository,
    contextFiles: makeResourceReport(
      input.contextFileItems,
      input.contextPolicy,
    ),
    skills: makeResourceReport(input.skillItems, input.skillPolicy),
    configPath: input.configPath,
  };
}

function inlineList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "(none)";
}

function compactList(items: string[], limit: number): string {
  if (items.length <= limit) return inlineList(items);

  const shown = items.slice(0, limit);
  return `${shown.join(", ")}, … +${items.length - shown.length} more`;
}

function pushSection(
  lines: string[],
  title: string,
  body: Array<{
    label?: string;
    text: string;
    tone?: "muted" | "success" | "dim" | "warning";
  }>,
  theme: Theme,
): void {
  lines.push(theme.fg("accent", `[${title}]`));
  for (const line of body) {
    const tone = line.tone ?? "muted";
    const prefix = line.label ? `${theme.fg("muted", `${line.label}:`)} ` : "";
    lines.push(`  ${prefix}${theme.fg(tone, line.text)}`);
  }
  lines.push("");
}

function resourceSectionBody(report: ResourceReport): Array<{
  label?: string;
  text: string;
  tone?: "muted" | "success" | "dim" | "warning";
}> {
  return [
    {
      label: "Policy",
      text: `${policySummary(report.policy)} (${report.enabled.length}/${report.total} enabled)`,
      tone: "muted",
    },
    {
      label: `Enabled (${report.enabled.length})`,
      text: compactList(report.enabled, 24),
      tone: "success",
    },
    {
      label: `Ignored (${report.ignored.length})`,
      text: compactList(report.ignored, 24),
      tone: "dim",
    },
    ...(report.stale.length > 0
      ? [
          {
            label: `Stale (${report.stale.length})`,
            text: compactList(report.stale, 12),
            tone: "warning" as const,
          },
        ]
      : []),
  ];
}

export function renderContextControlReport(
  report: ContextControlReport,
  theme: Theme,
): Component {
  const lines: string[] = [];

  lines.push(theme.fg("accent", theme.bold("[Context Control]")));
  lines.push(theme.fg("muted", `  Repository: ${report.repository}`));
  lines.push(
    theme.fg(
      "muted",
      "  Global/user context files and skills are always kept.",
    ),
  );
  lines.push("");

  pushSection(
    lines,
    "Project Context",
    resourceSectionBody(report.contextFiles),
    theme,
  );
  pushSection(
    lines,
    "Project Skills",
    resourceSectionBody(report.skills),
    theme,
  );

  if (lines.at(-1) === "") lines.pop();

  return new Text(lines.join("\n"), 0, 0);
}
