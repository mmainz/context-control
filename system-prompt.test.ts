import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatSkillsForPrompt,
  getPackageDir,
  type BuildSystemPromptOptions,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { filterSkillSystemPrompt, formatSkillsSection } from "./system-prompt";

type SystemPromptBuilder = (options: BuildSystemPromptOptions) => string;

async function loadCurrentPiBuilder(): Promise<SystemPromptBuilder> {
  const modulePath = join(getPackageDir(), "dist", "core", "system-prompt.js");
  const module = (await import(pathToFileURL(modulePath).href)) as {
    buildSystemPrompt: SystemPromptBuilder;
  };
  return module.buildSystemPrompt;
}

function skill(name: string, hidden = false): Skill {
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
    disableModelInvocation: hidden,
  };
}

const kept = skill("kept");
const blocked = skill("blocked");
const hidden = skill("hidden", true);
const baseOptions: BuildSystemPromptOptions = {
  cwd: "/repo",
  contextFiles: [{ path: "/repo/AGENTS.md", content: "PROJECT_CONTEXT" }],
  skills: [kept, blocked, hidden],
};
const filteredOptions: BuildSystemPromptOptions = {
  ...baseOptions,
  skills: [kept, hidden],
};

describe("skill prompt filtering", () => {
  it.each([
    { selectedTools: undefined, visible: true },
    { selectedTools: ["read"], visible: true },
    { selectedTools: ["bash"], visible: true },
    { selectedTools: ["read", "bash"], visible: true },
    { selectedTools: ["edit", "write"], visible: false },
    { selectedTools: [], visible: false },
  ])("detects skill awareness for $selectedTools", ({ selectedTools, visible }) => {
    const options = {
      ...baseOptions,
      ...(selectedTools === undefined ? {} : { selectedTools }),
    };

    expect(formatSkillsSection(options).includes("blocked description")).toBe(visible);
  });

  it("removes blocked skill entries when only bash can read files", () => {
    const options = { ...baseOptions, selectedTools: ["bash"] };
    const result = filterSkillSystemPrompt({
      currentSystemPrompt: formatSkillsForPrompt(options.skills ?? []),
      baseOptions: options,
      filteredOptions: { ...options, skills: [kept, hidden] },
    });

    expect(result.recognizedSkillSection).toBe(true);
    expect(result.systemPrompt).toContain("kept description");
    expect(result.systemPrompt).not.toContain("blocked description");
    expect(result.systemPrompt).not.toContain(blocked.filePath);
  });

  it("leaves the prompt unchanged when the skill manifest is unchanged", () => {
    expect(
      filterSkillSystemPrompt({
        currentSystemPrompt: "custom prompt",
        baseOptions,
        filteredOptions: baseOptions,
      }),
    ).toEqual({
      systemPrompt: "custom prompt",
      recognizedSkillSection: true,
    });
  });

  it("removes blocked skills while preserving Pi-managed context files", async () => {
    const builder = await loadCurrentPiBuilder();
    const currentSystemPrompt = builder(baseOptions);

    const result = filterSkillSystemPrompt({
      currentSystemPrompt,
      baseOptions,
      filteredOptions,
    });

    expect(result.recognizedSkillSection).toBe(true);
    expect(result.systemPrompt).toContain("PROJECT_CONTEXT");
    expect(result.systemPrompt).toContain("kept description");
    expect(result.systemPrompt).not.toContain("blocked description");
  });

  it("does not rewrite skill-like XML inside Pi-managed instruction files", async () => {
    const builder = await loadCurrentPiBuilder();
    const instructionManifest = formatSkillsForPrompt([blocked]);
    const options = {
      ...baseOptions,
      contextFiles: [
        {
          path: "/repo/AGENTS.md",
          content: instructionManifest,
        },
      ],
    };

    const result = filterSkillSystemPrompt({
      currentSystemPrompt: builder(options),
      baseOptions: options,
      filteredOptions: { ...options, skills: [kept, hidden] },
    });

    expect(result.recognizedSkillSection).toBe(true);
    expect(result.systemPrompt).toContain(instructionManifest);
    expect(result.systemPrompt.match(/blocked description/g)).toHaveLength(1);
  });

  it("preserves prompt changes wrapped around Pi's skill section", async () => {
    const builder = await loadCurrentPiBuilder();
    const currentSystemPrompt = `prefix\n${builder(baseOptions)}\nsuffix`;

    const result = filterSkillSystemPrompt({
      currentSystemPrompt,
      baseOptions,
      filteredOptions,
    });

    expect(result.recognizedSkillSection).toBe(true);
    expect(result.systemPrompt.startsWith("prefix\n")).toBe(true);
    expect(result.systemPrompt.endsWith("\nsuffix")).toBe(true);
    expect(result.systemPrompt).not.toContain("blocked description");
  });

  it("filters every duplicated generated skill section", () => {
    const section = formatSkillsSection(baseOptions);

    const result = filterSkillSystemPrompt({
      currentSystemPrompt: `${section}\n${section}`,
      baseOptions,
      filteredOptions,
    });

    expect(result.recognizedSkillSection).toBe(true);
    expect(result.systemPrompt).not.toContain("blocked description");
    expect(result.systemPrompt.match(/kept description/g)).toHaveLength(2);
  });

  it("falls back to removing identifiable blocked skill entries", () => {
    const blockedSection = formatSkillsForPrompt([blocked]);
    const blockedEntry = /<available_skills>\n([\s\S]+)\n<\/available_skills>/.exec(
      blockedSection,
    )?.[1];
    const currentSystemPrompt = `custom wrapper\n<available_skills>\n<!-- upstream -->\n${blockedEntry}\n</available_skills>\ncustom suffix`;

    const result = filterSkillSystemPrompt({
      currentSystemPrompt,
      baseOptions,
      filteredOptions,
    });

    expect(result.recognizedSkillSection).toBe(true);
    expect(result.systemPrompt).toContain("upstream");
    expect(result.systemPrompt).not.toContain("blocked description");
  });

  it("recognizes an upstream replacement that already excludes blocked skills", () => {
    expect(
      filterSkillSystemPrompt({
        currentSystemPrompt: "replacement without project skills",
        baseOptions,
        filteredOptions,
      }),
    ).toEqual({
      systemPrompt: "replacement without project skills",
      recognizedSkillSection: true,
    });
  });

  it("reports a transformed blocked skill that cannot be removed safely", () => {
    const transformed = `${blocked.filePath}\ntransformed blocked description`;

    expect(
      filterSkillSystemPrompt({
        currentSystemPrompt: transformed,
        baseOptions,
        filteredOptions,
      }),
    ).toEqual({
      systemPrompt: transformed,
      recognizedSkillSection: false,
    });
  });

  it("reports transformed blocked skills even when their path was removed", () => {
    const transformed = `<skill>\n<name>${blocked.name}</name>\n<description>${blocked.description} (transformed)</description>\n</skill>`;

    expect(
      filterSkillSystemPrompt({
        currentSystemPrompt: transformed,
        baseOptions,
        filteredOptions,
      }),
    ).toEqual({
      systemPrompt: transformed,
      recognizedSkillSection: false,
    });
  });

  it("protects exact custom and appended skill-like text", async () => {
    const builder = await loadCurrentPiBuilder();
    const protectedText = formatSkillsForPrompt([blocked]);
    const options = {
      ...baseOptions,
      customPrompt: protectedText,
      appendSystemPrompt: protectedText,
    };

    const result = filterSkillSystemPrompt({
      currentSystemPrompt: builder(options),
      baseOptions: options,
      filteredOptions: { ...options, skills: [kept, hidden] },
    });

    expect(result.recognizedSkillSection).toBe(true);
    expect(result.systemPrompt.match(/blocked description/g)).toHaveLength(2);
  });

  it("preserves upstream skill annotations while removing blocked skills", async () => {
    const builder = await loadCurrentPiBuilder();
    const currentSystemPrompt = builder(baseOptions).replace(
      "<available_skills>",
      "<available_skills>\n  <!-- upstream annotation -->",
    );

    const result = filterSkillSystemPrompt({
      currentSystemPrompt,
      baseOptions,
      filteredOptions,
    });

    expect(result.recognizedSkillSection).toBe(true);
    expect(result.systemPrompt).toContain("upstream annotation");
    expect(result.systemPrompt).toContain("kept description");
    expect(result.systemPrompt).not.toContain("blocked description");
  });
});
