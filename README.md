# context-control

A Pi extension for controlling which project skills are included in automatic model context for each repository.

Skill filtering is tested with `@earendil-works/pi-coding-agent` 0.80.10 and 1.3.0. Requires Node.js 22.19 or newer.

## Usage

Install or load the package, then run:

```text
/context-control
```

The command opens a guided flow for project skills in Pi's interactive TUI:

- Use all
- Use none
- Block selected
- Allow selected
- Inspect context usage
- Clean stale entries

`Allow selected` enables only selected project skills, so newly discovered project skills remain unavailable to the model until explicitly allowed. `Block selected` keeps new project skills enabled by default and excludes only selected skills.

Pi exclusively discovers and loads `AGENTS.md` and `CLAUDE.md` instruction files. Context-control does not discover, inject, filter, or configure them. Global/user skills are also outside repository policy and always remain available to the model.

On startup and `/reload`, context-control adds a concise notification and status with effective project-skill counts. Run `/context-control` for the current policy and counts of enabled skills, ignored skills, and stale entries. The main screen does not list individual skills, keeping it compact in fullscreen mode even in repositories with large skill inventories. Browse individual skills through **Configure project skills… → Block selected… / Allow selected…**, or inspect them with `/context-control usage full`. The command reads Pi's current system-prompt options, so its inventory matches skills loaded from packages, settings, CLI options, and the active project.

The extension filters automatic model awareness only. Disabled project skills are removed from the system prompt, but explicit `/skill:name` commands still work when Pi's skill commands are enabled. Skills with `disable-model-invocation: true` are already explicit-only in Pi, so context-control excludes them from policy counts while preserving any registered `/skill:name` invocation.

## Context usage

Open the context report from the main menu or directly:

```text
/context-control usage
/context-control usage full
```

The report analyzes the effective prompt after applying the repository's skill policy. It shows Pi-managed instruction files informationally and distinguishes model-visible skills, skill-policy-blocked skills, explicit-only skills, and registered skill slash commands. The full view includes:

- A segmented context-window pressure map and proportional composition bars
- A full-view heatmap ranking the largest instruction files, skills, tools, and messages
- Active instruction-file and skill-manifest shares of the context window
- Estimated tokens and context-window percentage saved by blocked project skills
- Pi-reported usage and an independently estimated snapshot
- System-prompt composition
- Model-visible, blocked, explicit-only, and reader-disabled skills
- Guidelines and tool snippets
- Active tool-definition estimates
- The compaction-aware conversation breakdown
- Compaction reserve, free space, warnings, and estimate methodology

Pi's reported total is authoritative when available. Component values are estimates because Pi does not expose provider-specific component tokenizers. Viewing the report does not add a message to the session or register an agent-callable tool, and it does not depend on another context-analysis extension.

In RPC, JSON, and print modes, automatic filtering remains active but the interactive `/context-control` command is unavailable. RPC clients receive a warning instead of a silent no-op.

## Persistence

Repository settings are stored outside the shared repository under:

```text
~/.pi/agent/context-control/
```

For Git repositories, the config key is based on `git rev-parse --path-format=absolute --git-common-dir`, so linked worktrees for the same clone share one context-control configuration.

Skill identities are path-based. Project skills inside the current worktree use `repo:<relative-path>` ids, which makes the same config usable across linked worktrees. Symlinked skills use the link location for repository ownership, so a project can control links whose targets live outside the worktree. Skills absent from the current worktree remain as stale references until explicitly cleaned.

Repository identity is cached for the current Pi session, while the configuration file is reread before commands and agent turns. External edits are therefore observed between operations; edits made while the interactive configuration flow is already open are not merged into that in-progress transaction.

Legacy version-1 configuration files are read safely: their skill policy is migrated in memory and their former context-file policy is ignored. The next explicit save writes the skill-only version-2 schema.

## Compatibility notes

Skill filtering remains active when `bash` is available without the `read` tool, including bash-only sessions in Pi 1.3.0.

Context-control rewrites only Pi's generated skill section and leaves Pi-managed instruction sections untouched. It preserves earlier `before_agent_start` changes around the skill section. If another extension transforms blocked skill entries so they cannot be identified safely, context-control removes recognizable entries and emits one warning when filtering may be incomplete.

The runtime uses Pi's public structured prompt options and skill formatter. The compatibility test suite compares skill filtering against the current Pi prompt builder; the shipped extension does not import Pi's private internals.

## Development

Install dependencies:

```bash
bun install
```

Run checks, including the isolated real-Pi startup and skill-policy integration tests:

```bash
bun run check
```

Run only the real-Pi integration tests:

```bash
bun run test:integration
```

By default, integration tests use the repository's pinned Pi dependency. To test the installed Pi CLI instead:

```bash
CONTEXT_CONTROL_PI_CLI="$(command -v pi)" bun run test:integration
```

The probe checks the full provider context, including transcript system messages in newer Pi versions. Policy tests compare default-tool and bash-only sessions against a control run without context-control.

Try the extension locally:

```bash
pi -e .
```

## Pi package manifest

This package exposes the extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```
