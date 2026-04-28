# context-control

A pi extension for selecting which `AGENTS.md` files and skills are active in a repository.

## Status

Initial scaffold only. The extension currently registers a placeholder `/context-control` command.

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

## Planned behavior

Selections will be stored in user-global pi config keyed by repository path/git root, for example under `~/.pi/agent/context-control/`, so preferences are sticky across sessions without modifying shared repositories.
