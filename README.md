# context-control

A pi extension for selecting which project-level context files and skills are active in a repository.

## Usage

Install or load the package, then run:

```text
/context-control
```

The command opens a guided flow for project-level context files and skills:

- Use all
- Use none
- Block selected
- Allow selected
- Clean stale entries

`Allow selected` switches that project resource type to an allowlist, so newly discovered project files or skills are ignored until explicitly allowed. `Block selected` keeps new project resources enabled by default and excludes only selected resources.

Global/user-level `AGENTS.md` files and skills are always kept. They are intentionally outside this extension's policy controls.

On startup and `/reload`, pi's built-in resource list still shows raw discovery. The extension adds a concise notification/status with effective project counts; run `/context-control` to view the detailed project context and skill policies, enabled entries, and ignored entries.

The extension filters automatic model awareness only. Disabled project skills are removed from the system prompt, but explicit `/skill:name` commands still work.

## Persistence

Repository settings are stored outside the shared repository under:

```text
~/.pi/agent/context-control/
```

For git repositories, the config key is based on `git rev-parse --path-format=absolute --git-common-dir`, so linked worktrees for the same clone share one context-control configuration.

Resource identities are path-based. Project resources inside the current worktree use `repo:<relative-path>` ids, which makes the same config usable across linked worktrees.

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
