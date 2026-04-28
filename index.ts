import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const EXTENSION_NAME = "context-control";

export default function contextControl(pi: ExtensionAPI) {
  pi.registerCommand(EXTENSION_NAME, {
    description:
      "Configure which AGENTS.md files and skills pi should use in this repository.",
    handler: (_args, ctx) => {
      ctx.ui.notify(
        "context-control is installed. Repository context selection is not implemented yet.",
        "info",
      );
      return Promise.resolve();
    },
  });
}
