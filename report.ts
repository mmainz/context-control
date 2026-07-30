import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { applyResourcePolicy, policyRefs, staleRefs } from "./filtering";
import type { ResourceItem, ResourcePolicy, ResourceRef, RuntimeConfig } from "./types";

export interface ResourceReport {
  mode: ResourcePolicy["mode"];
  enabled: ResourceItem[];
  ignored: ResourceItem[];
  stale: ResourceRef[];
  configuredRefs: ResourceRef[];
}

export interface ContextControlReport {
  repository: string;
  skills: ResourceReport;
}

function makeResourceReport(items: ResourceItem[], policy: ResourcePolicy): ResourceReport {
  const enabled = applyResourcePolicy(items, policy);
  const enabledIds = new Set(enabled.map((item) => item.ref.id));
  return {
    mode: policy.mode,
    enabled,
    ignored: items.filter((item) => !enabledIds.has(item.ref.id)),
    stale: staleRefs(items, policy),
    configuredRefs: policyRefs(policy),
  };
}

export function makeContextControlReport(
  runtime: RuntimeConfig,
  skillItems: ResourceItem[],
): ContextControlReport {
  return {
    repository: runtime.repository.label,
    skills: makeResourceReport(skillItems, runtime.config.skills),
  };
}

function displayRefPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function itemLabel(item: ResourceItem): string {
  return item.ref.label ?? displayRefPath(item.ref.path);
}

function refLabel(ref: ResourceRef): string {
  return ref.label ?? displayRefPath(ref.path);
}

function resourceSectionBody(report: ResourceReport): string[] {
  const lines = [`  Policy: ${report.mode}`, `  Enabled: ${report.enabled.length}`];
  for (const item of report.enabled) lines.push(`    + ${itemLabel(item)}`);
  lines.push(`  Ignored: ${report.ignored.length}`);
  for (const item of report.ignored) lines.push(`    - ${itemLabel(item)}`);
  lines.push(`  Stale configured entries: ${report.stale.length}`);
  for (const ref of report.stale) lines.push(`    ! ${refLabel(ref)}`);
  return lines;
}

export function renderContextControlReport(report: ContextControlReport, theme: Theme): Text {
  const lines = [
    theme.fg("accent", theme.bold("[Context Control]")),
    `${theme.fg("muted", "Repository:")} ${report.repository}`,
    "",
    theme.fg("accent", theme.bold("[Project Skills]")),
    ...resourceSectionBody(report.skills).map((line) =>
      line.trimStart().startsWith("!") ? theme.fg("warning", line) : theme.fg("muted", line),
    ),
    "",
    theme.fg(
      "dim",
      "Pi manages AGENTS.md and CLAUDE.md; instruction files are not configurable here.",
    ),
    theme.fg("dim", "Global/user skills remain outside this repository policy."),
  ];
  return new Text(lines.join("\n"), 0, 0);
}
