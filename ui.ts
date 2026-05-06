import { relative } from "node:path";

import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@mariozechner/pi-coding-agent";

import {
  createPolicy,
  countEnabled,
  policyRefs,
  preserveStaleRefs,
  pruneStaleRefs,
  staleRefs,
} from "./filtering";
import { discoverContextFiles, discoverSkills } from "./resources";
import { saveConfig } from "./config";
import { makeContextControlReport, renderContextControlReport } from "./report";
import type {
  ContextControlConfig,
  ResourceItem,
  ResourceKind,
  ResourcePolicy,
  ResourceRef,
  RuntimeConfig,
} from "./types";

type ResourceLoader = () => Promise<ResourceItem[]>;

function resourceKindLabel(kind: ResourceKind): string {
  return kind === "contextFiles" ? "project context files" : "project skills";
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

function resourceLabel(item: ResourceItem, repositoryLabel: string): string {
  const relativePath = item.ref.id.startsWith("repo:")
    ? relative(repositoryLabel, item.ref.path)
    : item.ref.path;
  const description = item.description ? ` — ${item.description}` : "";
  return `${item.ref.label ?? item.ref.path} (${relativePath})${description}`;
}

function mergeRefs(
  items: ResourceItem[],
  selectedIds: Set<string>,
): ResourceRef[] {
  return items
    .filter((item) => selectedIds.has(item.ref.id))
    .map((item) => item.ref);
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
      selectedIndex = Math.min(
        selectedIndex,
        Math.max(0, filteredItems.length - 1),
      );
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
          Math.min(
            selectedIndex - Math.floor(maxVisible / 2),
            filteredItems.length - maxVisible,
          ),
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
            const group = item.ref.group
              ? theme.fg("muted", `${item.ref.group} `)
              : "";
            const label = resourceLabel(item, repositoryLabel);
            const text = isSelected ? theme.fg("accent", label) : label;
            lines.push(
              truncateToWidth(`${cursor} ${marker} ${group}${text}`, width),
            );
          }

          if (start > 0 || end < filteredItems.length) {
            lines.push(
              theme.fg(
                "dim",
                `  (${selectedIndex + 1}/${filteredItems.length})`,
              ),
            );
          }

          const selectedItem = filteredItems[selectedIndex];
          if (selectedItem?.description) {
            lines.push("");
            for (const line of wrapTextWithAnsi(
              selectedItem.description,
              width - 4,
            )) {
              lines.push(theme.fg("muted", `  ${line}`));
            }
          }
        }

        lines.push("");
        lines.push(
          truncateToWidth(
            theme.fg(
              "dim",
              "↑↓ navigate · Enter/Space toggle · type search · Backspace edit · Ctrl+A select filtered · Ctrl+X clear filtered · Esc done",
            ),
            width,
          ),
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
    const nextIndex =
      selectedIndex === 0 ? actions.length - 1 : selectedIndex - 1;
    requestRender();
    return nextIndex;
  }
  if (matchesKey(data, Key.down)) {
    const nextIndex =
      selectedIndex === actions.length - 1 ? 0 : selectedIndex + 1;
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

    if (isSelected && action.description) {
      for (const line of wrapTextWithAnsi(action.description, width - 4)) {
        lines.push(theme.fg("muted", `    ${line}`));
      }
    }
  }

  lines.push("");
  lines.push(truncateToWidth(theme.fg("dim", hint), width));
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
        selectedIndex = handleActionMenuInput(
          data,
          actions,
          selectedIndex,
          done,
          () => tui.requestRender(),
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
    new Set(
      existing.filter((ref) => currentIds.has(ref.id)).map((ref) => ref.id),
    ),
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
  kind: ResourceKind,
  mode: "blocklist" | "allowlist",
  refs: ResourceRef[],
  selectedCount: number,
  label: string,
  verb: string,
): Promise<void> {
  runtime.config[kind] = createPolicy(mode, refs);
  await saveConfig(runtime.configPath, runtime.config);
  const preservedCount = refs.length - selectedCount;
  ctx.ui.notify(
    `context-control: ${verb} ${selectedCount} current ${label}; preserved ${preservedCount} stale entr${preservedCount === 1 ? "y" : "ies"}.`,
    "info",
  );
}

async function configureResourceKind(
  ctx: ExtensionCommandContext,
  runtime: RuntimeConfig,
  kind: ResourceKind,
  loadResources: ResourceLoader,
): Promise<boolean> {
  const label = resourceKindLabel(kind);

  while (true) {
    const policy = runtime.config[kind];
    const resources = await loadResources();
    const enabled = countEnabled(resources, policy);
    const stale = staleRefs(resources, policy).length;
    const staleSuffix = stale > 0 ? `, ${stale} stale` : "";

    const choice = await chooseAction(
      ctx,
      `context-control: ${label}`,
      [
        `${enabled}/${resources.length} enabled (${policySummary(policy)}${staleSuffix})`,
      ],
      [
        {
          id: "use_all",
          label: "Use all",
          description:
            "Enable all current and newly discovered project resources of this type.",
        },
        {
          id: "use_none",
          label: "Use none",
          description: "Disable all project resources of this type.",
        },
        {
          id: "block_selected",
          label: "Block selected...",
          description:
            "Keep new project resources enabled by default, but disable selected entries.",
        },
        {
          id: "allow_selected",
          label: "Allow selected...",
          description:
            "Enable only selected project resources. Newly discovered entries stay disabled until allowed.",
        },
        { id: "back", label: "Back" },
      ],
    );

    if (!choice || choice === "back") return false;

    if (choice === "use_all") {
      runtime.config[kind] = createPolicy("all");
      await saveConfig(runtime.configPath, runtime.config);
      ctx.ui.notify(`context-control: ${label} set to use all.`, "info");
      return true;
    }

    if (choice === "use_none") {
      runtime.config[kind] = createPolicy("none");
      await saveConfig(runtime.configPath, runtime.config);
      ctx.ui.notify(`context-control: ${label} set to use none.`, "info");
      return true;
    }

    if (choice === "block_selected") {
      const existing = policy.mode === "blocklist" ? policyRefs(policy) : [];
      const selection = await choosePolicyRefs(
        ctx,
        `Block selected ${label}`,
        resources,
        existing,
        runtime.repository.label,
      );
      if (!selection) continue;

      await saveRefPolicy(
        ctx,
        runtime,
        kind,
        "blocklist",
        selection.refs,
        selection.selectedCount,
        label,
        "blocking",
      );
      return true;
    }

    if (choice === "allow_selected") {
      const existing =
        policy.mode === "allowlist"
          ? policyRefs(policy)
          : resources.map((item) => item.ref);
      const selection = await choosePolicyRefs(
        ctx,
        `Allow selected ${label}`,
        resources,
        existing,
        runtime.repository.label,
      );
      if (!selection) continue;

      await saveRefPolicy(
        ctx,
        runtime,
        kind,
        "allowlist",
        selection.refs,
        selection.selectedCount,
        label,
        "allowing",
      );
      return true;
    }
  }
}

async function cleanStaleRefs(
  ctx: ExtensionCommandContext,
  runtime: RuntimeConfig,
  loadContextFiles: ResourceLoader,
  loadSkills: ResourceLoader,
): Promise<boolean> {
  const contextFiles = await loadContextFiles();
  const skills = await loadSkills();
  const staleContextFiles = staleRefs(
    contextFiles,
    runtime.config.contextFiles,
  ).length;
  const staleSkills = staleRefs(skills, runtime.config.skills).length;

  if (staleContextFiles === 0 && staleSkills === 0) {
    ctx.ui.notify("context-control: no stale entries to clean.", "info");
    return false;
  }

  const confirmed = await ctx.ui.confirm(
    "Clean stale entries?",
    `Remove ${staleContextFiles} stale context file entries and ${staleSkills} stale skill entries from this repository config?`,
  );
  if (!confirmed) return false;

  runtime.config.contextFiles = pruneStaleRefs(
    contextFiles,
    runtime.config.contextFiles,
  );
  runtime.config.skills = pruneStaleRefs(skills, runtime.config.skills);
  await saveConfig(runtime.configPath, runtime.config);
  ctx.ui.notify("context-control: stale entries cleaned.", "info");
  return true;
}

function updateRepositoryMetadata(
  config: ContextControlConfig,
  runtime: RuntimeConfig,
): void {
  config.repository = {
    id: runtime.repository.id,
    label: runtime.repository.label,
    ...(runtime.repository.gitCommonDir
      ? { gitCommonDir: runtime.repository.gitCommonDir }
      : {}),
  };
}

export async function runContextControlCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runtime: RuntimeConfig,
): Promise<void> {
  updateRepositoryMetadata(runtime.config, runtime);

  const loadContextFiles = () => discoverContextFiles(ctx, runtime.repository);
  const loadSkills = () => discoverSkills(pi, runtime.repository);

  while (true) {
    const contextFiles = await loadContextFiles();
    const skills = await loadSkills();
    const report = makeContextControlReport({
      repository: runtime.repository.label,
      contextFileItems: contextFiles,
      skillItems: skills,
      contextPolicy: runtime.config.contextFiles,
      skillPolicy: runtime.config.skills,
      configPath: runtime.configPath,
    });

    const choice = await ctx.ui.custom<string | undefined>(
      (tui, theme, _kb, done) => {
        const reportComponent = renderContextControlReport(report, theme);
        const actions: ActionChoice[] = [
          {
            id: "configure_context",
            label: "Configure project context files...",
          },
          { id: "configure_skills", label: "Configure project skills..." },
          {
            id: "clean_stale",
            label: "Clean stale entries",
            description:
              "Remove config entries for project resources that are no longer discovered.",
          },
          { id: "done", label: "Done" },
        ];
        let selectedIndex = 0;

        return {
          invalidate() {
            reportComponent.invalidate();
          },
          handleInput(data: string) {
            selectedIndex = handleActionMenuInput(
              data,
              actions,
              selectedIndex,
              done,
              () => tui.requestRender(),
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
      },
    );

    if (!choice || choice === "done") return;

    if (choice === "configure_context") {
      await configureResourceKind(
        ctx,
        runtime,
        "contextFiles",
        loadContextFiles,
      );
      continue;
    }

    if (choice === "configure_skills") {
      await configureResourceKind(ctx, runtime, "skills", loadSkills);
      continue;
    }

    if (choice === "clean_stale") {
      await cleanStaleRefs(ctx, runtime, loadContextFiles, loadSkills);
    }
  }
}
