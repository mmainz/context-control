import { relative } from "node:path";

import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type {
  BuildSystemPromptOptions,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";

import {
  createPolicy,
  countEnabled,
  policyRefs,
  preserveStaleRefs,
  pruneStaleRefs,
  staleRefs,
} from "./filtering";
import { isProjectResource, skillsFromOptions } from "./resources";
import { saveConfig } from "./config";
import { makeContextControlReport, renderContextControlReport } from "./report";
import type {
  ContextControlConfig,
  ResourceItem,
  ResourcePolicy,
  ResourceRef,
  RuntimeConfig,
} from "./types";

type ResourceLoader = () => Promise<ResourceItem[]>;

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

function resourceLabel(item: ResourceItem, repositoryLabel: string): string {
  const relativePath = item.ref.id.startsWith("repo:")
    ? relative(repositoryLabel, item.ref.path)
    : item.ref.path;
  const description = item.description ? ` — ${item.description}` : "";
  const label = item.ref.label ?? item.ref.path;
  const location = label === relativePath ? "" : ` (${relativePath})`;
  return `${label}${location}${description}`;
}

function mergeRefs(items: ResourceItem[], selectedIds: Set<string>): ResourceRef[] {
  return items.filter((item) => selectedIds.has(item.ref.id)).map((item) => item.ref);
}

function filterItems(
  items: ResourceItem[],
  query: string,
  repositoryLabel: string,
): ResourceItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;

  return items.filter((item) => {
    const searchable = [
      item.ref.label,
      item.ref.path,
      item.ref.group,
      item.description,
      resourceLabel(item, repositoryLabel),
    ]
      .filter((part) => typeof part === "string")
      .join("\n")
      .toLowerCase();
    return searchable.includes(normalizedQuery);
  });
}

function pushWrappedDescription(
  lines: string[],
  description: string | undefined,
  width: number,
  theme: Theme,
  indent: string,
): void {
  if (!description) return;
  for (const line of wrapTextWithAnsi(description, width - 4)) {
    lines.push(theme.fg("muted", `${indent}${line}`));
  }
}

function pushMenuHint(lines: string[], hint: string, width: number, theme: Theme): void {
  lines.push("");
  lines.push(truncateToWidth(theme.fg("dim", hint), width));
}

async function chooseRefs(
  ctx: ExtensionCommandContext,
  title: string,
  items: ResourceItem[],
  initialSelection: Set<string>,
  repositoryLabel: string,
): Promise<ResourceRef[] | undefined> {
  const selectedIds = new Set(initialSelection);

  return ctx.ui.custom<ResourceRef[] | undefined>((tui, theme, _kb, done) => {
    let selectedIndex = 0;
    let query = "";
    let filteredItems = filterItems(items, query, repositoryLabel);

    function applyFilter() {
      filteredItems = filterItems(items, query, repositoryLabel);
      selectedIndex = Math.min(selectedIndex, Math.max(0, filteredItems.length - 1));
    }

    function toggleSelected() {
      const item = filteredItems[selectedIndex];
      if (!item) return;

      if (selectedIds.has(item.ref.id)) {
        selectedIds.delete(item.ref.id);
      } else {
        selectedIds.add(item.ref.id);
      }
    }

    function finish() {
      done(mergeRefs(items, selectedIds));
    }

    return {
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) {
          finish();
          return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
          toggleSelected();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.up)) {
          selectedIndex =
            filteredItems.length === 0
              ? 0
              : selectedIndex === 0
                ? filteredItems.length - 1
                : selectedIndex - 1;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down)) {
          selectedIndex =
            filteredItems.length === 0
              ? 0
              : selectedIndex === filteredItems.length - 1
                ? 0
                : selectedIndex + 1;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.backspace)) {
          query = query.slice(0, -1);
          applyFilter();
          tui.requestRender();
          return;
        }
        if (data === "\u0001") {
          for (const item of filteredItems) selectedIds.add(item.ref.id);
          tui.requestRender();
          return;
        }
        if (data === "\u0018") {
          for (const item of filteredItems) selectedIds.delete(item.ref.id);
          tui.requestRender();
          return;
        }
        if (data.length === 1 && data >= " " && data !== "\u007f") {
          query += data;
          applyFilter();
          tui.requestRender();
        }
      },
      render(width: number): string[] {
        const lines: string[] = [];
        const maxVisible = 12;
        const start = Math.max(
          0,
          Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredItems.length - maxVisible),
        );
        const end = Math.min(start + maxVisible, filteredItems.length);

        lines.push(theme.fg("accent", theme.bold(title)));
        lines.push(
          theme.fg(
            "dim",
            `Search: ${query || "(type to filter)"} · selected ${selectedIds.size}/${items.length}`,
          ),
        );
        lines.push("");

        if (filteredItems.length === 0) {
          lines.push(theme.fg("warning", "  No matching entries"));
        } else {
          for (let index = start; index < end; index++) {
            const item = filteredItems[index]!;
            const isSelected = index === selectedIndex;
            const cursor = isSelected ? theme.fg("accent", ">") : " ";
            const marker = selectedIds.has(item.ref.id)
              ? theme.fg("success", "[x]")
              : theme.fg("dim", "[ ]");
            const group = item.ref.group ? theme.fg("muted", `${item.ref.group} `) : "";
            const label = resourceLabel(item, repositoryLabel);
            const text = isSelected ? theme.fg("accent", label) : label;
            lines.push(truncateToWidth(`${cursor} ${marker} ${group}${text}`, width));
          }

          if (start > 0 || end < filteredItems.length) {
            lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${filteredItems.length})`));
          }

          const selectedItem = filteredItems[selectedIndex];
          if (selectedItem?.description) lines.push("");
          pushWrappedDescription(lines, selectedItem?.description, width, theme, "  ");
        }

        pushMenuHint(
          lines,
          "↑↓ navigate · Enter/Space toggle · type search · Backspace edit · Ctrl+A select filtered · Ctrl+X clear filtered · Esc done",
          width,
          theme,
        );
        return lines;
      },
    };
  });
}

interface ActionChoice {
  id: string;
  label: string;
  description?: string;
}

function handleActionMenuInput(
  data: string,
  actions: ActionChoice[],
  selectedIndex: number,
  done: (choice: string | undefined) => void,
  requestRender: () => void,
): number {
  if (matchesKey(data, Key.escape)) {
    done(undefined);
    return selectedIndex;
  }
  if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
    done(actions[selectedIndex]?.id);
    return selectedIndex;
  }
  if (matchesKey(data, Key.up)) {
    const nextIndex = selectedIndex === 0 ? actions.length - 1 : selectedIndex - 1;
    requestRender();
    return nextIndex;
  }
  if (matchesKey(data, Key.down)) {
    const nextIndex = selectedIndex === actions.length - 1 ? 0 : selectedIndex + 1;
    requestRender();
    return nextIndex;
  }

  return selectedIndex;
}

function pushActionMenuLines(
  lines: string[],
  actions: ActionChoice[],
  selectedIndex: number,
  width: number,
  theme: Theme,
  hint: string,
): void {
  lines.push("");

  for (const [index, action] of actions.entries()) {
    const isSelected = index === selectedIndex;
    const cursor = isSelected ? theme.fg("accent", ">") : " ";
    const label = isSelected ? theme.fg("accent", action.label) : action.label;
    lines.push(truncateToWidth(`${cursor} ${label}`, width));

    if (isSelected) {
      pushWrappedDescription(lines, action.description, width, theme, "    ");
    }
  }

  pushMenuHint(lines, hint, width, theme);
}

async function chooseAction(
  ctx: ExtensionCommandContext,
  title: string,
  infoLines: string[],
  actions: ActionChoice[],
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    let selectedIndex = 0;

    return {
      invalidate() {},
      handleInput(data: string) {
        selectedIndex = handleActionMenuInput(data, actions, selectedIndex, done, () =>
          tui.requestRender(),
        );
      },
      render(width: number): string[] {
        const lines: string[] = [theme.fg("accent", theme.bold(title))];

        if (infoLines.length > 0) {
          lines.push(theme.fg("accent", "[Status]"));
        }

        for (const infoLine of infoLines) {
          for (const line of wrapTextWithAnsi(infoLine, width)) {
            lines.push(theme.fg("dim", `  ${line}`));
          }
        }

        pushActionMenuLines(
          lines,
          actions,
          selectedIndex,
          width,
          theme,
          "↑↓ navigate · Enter/Space select · Esc back",
        );
        return lines;
      },
    };
  });
}

async function choosePolicyRefs(
  ctx: ExtensionCommandContext,
  title: string,
  resources: ResourceItem[],
  existing: ResourceRef[],
  repositoryLabel: string,
): Promise<{ refs: ResourceRef[]; selectedCount: number } | undefined> {
  const currentIds = new Set(resources.map((item) => item.ref.id));
  const selectedRefs = await chooseRefs(
    ctx,
    title,
    resources,
    new Set(existing.filter((ref) => currentIds.has(ref.id)).map((ref) => ref.id)),
    repositoryLabel,
  );
  if (!selectedRefs) return undefined;

  return {
    refs: preserveStaleRefs(resources, selectedRefs, existing),
    selectedCount: selectedRefs.length,
  };
}

async function saveRefPolicy(
  ctx: ExtensionCommandContext,
  runtime: RuntimeConfig,
  mode: "blocklist" | "allowlist",
  refs: ResourceRef[],
  selectedCount: number,
  label: string,
  verb: string,
): Promise<void> {
  runtime.config.skills = createPolicy(mode, refs);
  await saveConfig(runtime.configPath, runtime.config);
  const preservedCount = refs.length - selectedCount;
  ctx.ui.notify(
    `context-control: ${verb} ${selectedCount} current ${label}; preserved ${preservedCount} stale entr${preservedCount === 1 ? "y" : "ies"}.`,
    "info",
  );
}

const skillPolicyActions: ActionChoice[] = [
  {
    id: "use_all",
    label: "Use all",
    description: "Enable all current and newly discovered project skills.",
  },
  {
    id: "use_none",
    label: "Use none",
    description: "Disable all project skills from automatic model context.",
  },
  {
    id: "block_selected",
    label: "Block selected...",
    description: "Keep new project skills enabled by default, but disable selected entries.",
  },
  {
    id: "allow_selected",
    label: "Allow selected...",
    description: "Enable only selected project skills. Newly discovered entries stay disabled.",
  },
  { id: "back", label: "Back" },
];

function skillPolicyStatus(resources: ResourceItem[], policy: ResourcePolicy): string {
  const enabled = countEnabled(resources, policy);
  const stale = staleRefs(resources, policy).length;
  const staleSuffix = stale > 0 ? `, ${stale} stale` : "";
  return `${enabled}/${resources.length} enabled (${policySummary(policy)}${staleSuffix})`;
}

async function saveSimpleSkillPolicy(
  ctx: ExtensionCommandContext,
  runtime: RuntimeConfig,
  mode: "all" | "none",
): Promise<void> {
  runtime.config.skills = createPolicy(mode);
  await saveConfig(runtime.configPath, runtime.config);
  ctx.ui.notify(`context-control: project skills set to use ${mode}.`, "info");
}

function initialSelectedRefs(
  mode: "blocklist" | "allowlist",
  policy: ResourcePolicy,
  resources: ResourceItem[],
): ResourceRef[] {
  if (policy.mode === mode) return policyRefs(policy);
  return mode === "allowlist" ? resources.map((item) => item.ref) : [];
}

async function configureSelectedSkillPolicy(
  ctx: ExtensionCommandContext,
  runtime: RuntimeConfig,
  resources: ResourceItem[],
  policy: ResourcePolicy,
  mode: "blocklist" | "allowlist",
): Promise<boolean> {
  const action = mode === "blocklist" ? "Block" : "Allow";
  const selection = await choosePolicyRefs(
    ctx,
    `${action} selected project skills`,
    resources,
    initialSelectedRefs(mode, policy, resources),
    runtime.repository.label,
  );
  if (!selection) return false;

  await saveRefPolicy(
    ctx,
    runtime,
    mode,
    selection.refs,
    selection.selectedCount,
    "project skills",
    mode === "blocklist" ? "blocking" : "allowing",
  );
  return true;
}

async function applySkillPolicyChoice(
  choice: string,
  ctx: ExtensionCommandContext,
  runtime: RuntimeConfig,
  resources: ResourceItem[],
  policy: ResourcePolicy,
): Promise<boolean> {
  switch (choice) {
    case "use_all":
      await saveSimpleSkillPolicy(ctx, runtime, "all");
      return true;
    case "use_none":
      await saveSimpleSkillPolicy(ctx, runtime, "none");
      return true;
    case "block_selected":
      return configureSelectedSkillPolicy(ctx, runtime, resources, policy, "blocklist");
    case "allow_selected":
      return configureSelectedSkillPolicy(ctx, runtime, resources, policy, "allowlist");
    default:
      return false;
  }
}

async function configureSkills(
  ctx: ExtensionCommandContext,
  runtime: RuntimeConfig,
  loadResources: ResourceLoader,
): Promise<boolean> {
  while (true) {
    const policy = runtime.config.skills;
    const resources = await loadResources();
    const choice = await chooseAction(
      ctx,
      "context-control: project skills",
      [skillPolicyStatus(resources, policy)],
      skillPolicyActions,
    );

    if (!choice || choice === "back") return false;
    if (await applySkillPolicyChoice(choice, ctx, runtime, resources, policy)) return true;
  }
}

async function cleanStaleRefs(
  ctx: ExtensionCommandContext,
  runtime: RuntimeConfig,
  loadSkills: ResourceLoader,
): Promise<boolean> {
  const skills = await loadSkills();
  const staleSkills = staleRefs(skills, runtime.config.skills).length;

  if (staleSkills === 0) {
    ctx.ui.notify("context-control: no stale skill entries to clean.", "info");
    return false;
  }

  const confirmed = await ctx.ui.confirm(
    "Clean stale skill entries?",
    `Remove ${staleSkills} stale skill entr${staleSkills === 1 ? "y" : "ies"} from this repository config?`,
  );
  if (!confirmed) return false;

  runtime.config.skills = pruneStaleRefs(skills, runtime.config.skills);
  await saveConfig(runtime.configPath, runtime.config);
  ctx.ui.notify("context-control: stale skill entries cleaned.", "info");
  return true;
}

function updateRepositoryMetadata(config: ContextControlConfig, runtime: RuntimeConfig): void {
  config.repository = {
    id: runtime.repository.id,
    label: runtime.repository.label,
    ...(runtime.repository.gitCommonDir ? { gitCommonDir: runtime.repository.gitCommonDir } : {}),
  };
}

export async function runContextControlCommand(
  ctx: ExtensionCommandContext,
  runtime: RuntimeConfig,
  options: BuildSystemPromptOptions,
  showUsage: (full: boolean) => Promise<void>,
): Promise<void> {
  updateRepositoryMetadata(runtime.config, runtime);

  const skills = (await skillsFromOptions(options, runtime.repository)).filter(isProjectResource);
  const loadSkills = () => Promise.resolve(skills);

  while (true) {
    const report = makeContextControlReport(runtime, await loadSkills());

    const choice = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
      const reportComponent = renderContextControlReport(report, theme);
      const actions: ActionChoice[] = [
        { id: "configure_skills", label: "Configure project skills..." },
        {
          id: "context_usage",
          label: "Context usage...",
          description: "Inspect the effective policy-filtered context window and token estimates.",
        },
        {
          id: "clean_stale",
          label: "Clean stale entries",
          description: "Remove config entries for project skills that are no longer discovered.",
        },
        { id: "done", label: "Done" },
      ];
      let selectedIndex = 0;

      return {
        invalidate() {
          reportComponent.invalidate();
        },
        handleInput(data: string) {
          selectedIndex = handleActionMenuInput(data, actions, selectedIndex, done, () =>
            tui.requestRender(),
          );
        },
        render(width: number): string[] {
          const lines = [...reportComponent.render(width)];
          pushActionMenuLines(
            lines,
            actions,
            selectedIndex,
            width,
            theme,
            "↑↓ navigate · Enter/Space select · Esc close",
          );
          return lines;
        },
      };
    });

    if (!choice || choice === "done") return;

    if (choice === "configure_skills") {
      await configureSkills(ctx, runtime, loadSkills);
      continue;
    }

    if (choice === "context_usage") {
      await showUsage(false);
      continue;
    }

    if (choice === "clean_stale") {
      await cleanStaleRefs(ctx, runtime, loadSkills);
    }
  }
}
