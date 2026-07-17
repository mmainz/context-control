import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  getPackageDir,
  type BuildSystemPromptOptions,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  buildFilteredSystemPrompt,
  projectSystemPromptResources,
} from "./system-prompt";

type SystemPromptBuilder = (options: BuildSystemPromptOptions) => string;

async function loadCurrentPiBuilder(): Promise<SystemPromptBuilder> {
  const modulePath = join(getPackageDir(), "dist", "core", "system-prompt.js");
  const module = (await import(pathToFileURL(modulePath).href)) as {
    buildSystemPrompt: SystemPromptBuilder;
  };
  return module.buildSystemPrompt;
}

const baseOptions: BuildSystemPromptOptions = {
  cwd: "/repo",
  contextFiles: [{ path: "/repo/AGENTS.md", content: "PROJECT_CONTEXT" }],
  skills: [],
};
const filteredOptions: BuildSystemPromptOptions = {
  ...baseOptions,
  contextFiles: [],
};

function skill(name: string): Skill {
  return {
    name,
    description: `${name} description`,
    filePath: `/repo/.pi/skills/${name}/SKILL.md`,
    baseDir: `/repo/.pi/skills/${name}`,
    sourceInfo: {
      path: `/repo/.pi/skills/${name}/SKILL.md`,
      source: "skills",
      scope: "project",
      origin: "top-level",
    },
    disableModelInvocation: false,
  };
}

describe("system prompt filtering", () => {
  it("removes context from Pi's current base prompt", async () => {
    const builder = await loadCurrentPiBuilder();
    const currentSystemPrompt = builder(baseOptions);

    const result = buildFilteredSystemPrompt({
      currentSystemPrompt,
      baseOptions,
      filteredOptions,
    });

    expect(result.preservedChainedChanges).toBe(true);
    expect(result.systemPrompt).not.toContain("PROJECT_CONTEXT");
    expect(result.systemPrompt).toContain("Current working directory: /repo");
  });

  it("preserves prompt changes wrapped around Pi's resource sections", async () => {
    const builder = await loadCurrentPiBuilder();
    const currentSystemPrompt = `prefix\n${builder(baseOptions)}\nsuffix`;

    const result = buildFilteredSystemPrompt({
      currentSystemPrompt,
      baseOptions,
      filteredOptions,
    });

    expect(result).toMatchObject({ preservedChainedChanges: true });
    expect(result.systemPrompt.startsWith("prefix\n")).toBe(true);
    expect(result.systemPrompt.endsWith("\nsuffix")).toBe(true);
    expect(result.systemPrompt).not.toContain("PROJECT_CONTEXT");
  });

  it("filters every duplicated resource section", async () => {
    const builder = await loadCurrentPiBuilder();
    const basePrompt = builder(baseOptions);

    const result = buildFilteredSystemPrompt({
      currentSystemPrompt: `${basePrompt}\n${basePrompt}`,
      baseOptions,
      filteredOptions,
    });

    expect(result.preservedChainedChanges).toBe(true);
    expect(result.systemPrompt).not.toContain("PROJECT_CONTEXT");
  });

  it("falls back to removing every identifiable resource entry", () => {
    const entry =
      '<project_instructions path="/repo/AGENTS.md">\nPROJECT_CONTEXT\n</project_instructions>\n\n';
    const currentSystemPrompt = `custom wrapper\n${entry}${entry}custom suffix`;

    expect(
      buildFilteredSystemPrompt({
        currentSystemPrompt,
        baseOptions,
        filteredOptions,
      }),
    ).toEqual({
      systemPrompt: "custom wrapper\ncustom suffix",
      preservedChainedChanges: true,
    });
  });

  it("recognizes when a replacement already excludes blocked resources", () => {
    expect(
      buildFilteredSystemPrompt({
        currentSystemPrompt: "replacement without project resources",
        baseOptions,
        filteredOptions,
      }),
    ).toEqual({
      systemPrompt: "replacement without project resources",
      preservedChainedChanges: true,
    });
  });

  it("reports when a transformed blocked resource cannot be removed safely", () => {
    expect(
      buildFilteredSystemPrompt({
        currentSystemPrompt: "transformed instructions from /repo/AGENTS.md",
        baseOptions,
        filteredOptions,
      }),
    ).toEqual({
      systemPrompt: "transformed instructions from /repo/AGENTS.md",
      preservedChainedChanges: false,
    });
  });

  it("protects custom and appended XML while projecting resources", async () => {
    const builder = await loadCurrentPiBuilder();
    const customPrompt =
      'custom <project_context>\n<project_instructions path="/repo/AGENTS.md">CUSTOM_CONTEXT</project_instructions>\n</project_context>';
    const appendSystemPrompt =
      'append <project_context>\n<project_instructions path="/repo/AGENTS.md">APPEND_CONTEXT</project_instructions>\n</project_context>';
    const options = {
      ...baseOptions,
      customPrompt,
      appendSystemPrompt,
    };

    const result = projectSystemPromptResources({
      currentSystemPrompt: builder(options),
      baseOptions: options,
      filteredOptions: { ...options, contextFiles: [] },
    });

    expect(result.recognizedResourceSections).toBe(true);
    expect(result.systemPrompt).toContain("CUSTOM_CONTEXT");
    expect(result.systemPrompt).toContain("APPEND_CONTEXT");
    expect(result.systemPrompt).not.toContain("PROJECT_CONTEXT");
  });

  it("projects newly allowed resources into an already-filtered prompt", () => {
    const previousOptions: BuildSystemPromptOptions = {
      cwd: "/repo",
      contextFiles: [
        { path: "/repo/previous.md", content: "PREVIOUS_CONTEXT" },
      ],
      skills: [],
    };
    const nextOptions: BuildSystemPromptOptions = {
      cwd: "/repo",
      contextFiles: [{ path: "/repo/next.md", content: "NEXT_CONTEXT" }],
      skills: [],
    };
    const currentSystemPrompt = `base\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/previous.md">\nPREVIOUS_CONTEXT\n</project_instructions>\n\n</project_context>\n`;

    const result = projectSystemPromptResources({
      currentSystemPrompt,
      baseOptions: {
        ...previousOptions,
        contextFiles: [
          ...(previousOptions.contextFiles ?? []),
          ...(nextOptions.contextFiles ?? []),
        ],
      },
      filteredOptions: nextOptions,
    });

    expect(result.recognizedResourceSections).toBe(true);
    expect(result.systemPrompt).toContain("NEXT_CONTEXT");
    expect(result.systemPrompt).not.toContain("PREVIOUS_CONTEXT");
  });

  it("uses Pi's public skill formatter when filtering skills", async () => {
    const builder = await loadCurrentPiBuilder();
    const kept = skill("kept");
    const removed = skill("removed");
    const options = {
      ...baseOptions,
      contextFiles: [],
      skills: [kept, removed],
    };
    const currentSystemPrompt = builder(options);

    const result = buildFilteredSystemPrompt({
      currentSystemPrompt,
      baseOptions: options,
      filteredOptions: { ...options, skills: [kept] },
    });

    expect(result.preservedChainedChanges).toBe(true);
    expect(result.systemPrompt).toContain("kept description");
    expect(result.systemPrompt).not.toContain("removed description");
  });
});
