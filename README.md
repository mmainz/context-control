# context-control

A pi extension for selecting which project-level context files and skills are active in a repository.

Tested with `@earendil-works/pi-coding-agent` 0.80.10. Requires Node.js 22.19 or newer.

## Usage

Install or load the package, then run:

```text
/context-control
```

The command opens a guided flow for project-level context files and skills in Pi's interactive TUI:

- Use all
- Use none
- Block selected
- Allow selected
- Inspect context usage
- Clean stale entries

`Allow selected` switches that project resource type to an allowlist, so newly discovered project files or skills are ignored until explicitly allowed. `Block selected` keeps new project resources enabled by default and excludes only selected resources.

Global/user-level `AGENTS.md` files and skills are always kept. They are intentionally outside this extension's policy controls.

On startup and `/reload`, pi's built-in resource list still shows raw discovery. The extension adds a concise notification/status with effective project counts; run `/context-control` to view the detailed project context and skill policies, enabled entries, and ignored entries. The command reads Pi's current system-prompt options, so its inventory matches resources loaded from packages, settings, CLI options, and the active project.

The extension filters automatic model awareness only. Disabled project skills are removed from the system prompt, but explicit `/skill:name` commands still work when Pi's skill commands are enabled. Skills with `disable-model-invocation: true` are already explicit-only in Pi, so context-control excludes them from policy counts while preserving any registered `/skill:name` invocation.

## Context usage

Open the policy-aware context report from the main menu or directly:

```text
/context-control usage
/context-control usage full
```

The report analyzes the effective prompt after applying this repository's context-file and skill policies. It distinguishes model-visible resources, policy-blocked resources, explicit-only skills, and currently registered skill slash commands. The full view includes:

- A segmented context-window pressure map and proportional composition bars
- A full-view heatmap ranking the largest files, skills, tools, and messages
- Active instruction-file and skill-manifest shares of the context window
- Estimated tokens and context-window percentage saved by ignored files and skills
- Pi-reported usage and an independently estimated snapshot
- System-prompt composition
- Effective and blocked context files and skills
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

For git repositories, the config key is based on `git rev-parse --path-format=absolute --git-common-dir`, so linked worktrees for the same clone share one context-control configuration.

Resource identities are path-based. Project resources inside the current worktree use `repo:<relative-path>` ids, which makes the same config usable across linked worktrees.

Repository identity is cached for the current Pi session, while the configuration file is reread before commands and agent turns. External edits are therefore observed between operations; edits made while the interactive configuration flow is already open are not merged into that in-progress transaction.

## Compatibility notes

Context-control rewrites only Pi's generated context and skill sections, preserving earlier `before_agent_start` changes around them. If another extension mutates those resource sections so they cannot be identified safely, context-control removes recognizable individual entries and emits one warning when filtering may be incomplete.

The runtime uses Pi's public structured prompt options and skill formatter. The compatibility test suite compares its section rewriting against the current Pi prompt builder so formatting changes fail clearly without requiring a private Pi import in the shipped extension.

## Development

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run check
```

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
