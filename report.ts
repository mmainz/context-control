import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { applyResourcePolicy, policyRefs, staleRefs } from "./filtering";
import type {
  ResourceItem,
  ResourcePolicy,
  ResourceRef,
  RuntimeConfig,
} from "./types";

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

function makeResourceReport(
  items: ResourceItem[],
  policy: ResourcePolicy,
): ResourceReport {
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

function resourceSectionBody(report: ResourceReport): string[] {
  return [
    `  Policy: ${report.mode}`,
    `  Enabled: ${report.enabled.length}`,
    `  Ignored: ${report.ignored.length}`,
    `  Stale configured entries: ${report.stale.length}`,
  ];
}

export function renderContextControlReport(
  report: ContextControlReport,
  theme: Theme,
): Text {
  const lines = [
    theme.fg("accent", theme.bold("[Context Control]")),
    `${theme.fg("muted", "Repository:")} ${report.repository}`,
    "",
    theme.fg("accent", theme.bold("[Project Skills]")),
    ...resourceSectionBody(report.skills).map((line) =>
      theme.fg("muted", line),
    ),
    "",
    theme.fg(
      "dim",
      "Pi manages AGENTS.md and CLAUDE.md; instruction files are not configurable here.",
    ),
    theme.fg(
      "dim",
      "Global/user skills remain outside this repository policy.",
    ),
  ];
  return new Text(lines.join("\n"), 0, 0);
}
