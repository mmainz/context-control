import {
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
  type Skill,
} from "@earendil-works/pi-coding-agent";

export interface SkillFilteredSystemPromptResult {
  systemPrompt: string;
  recognizedSkillSection: boolean;
}

export function formatSkillsSection(options: BuildSystemPromptOptions): string {
  const tools = options.selectedTools;
  const hasFileReader = tools === undefined || tools.includes("read") || tools.includes("bash");
  if (!hasFileReader) return "";

  return formatSkillsForPrompt(options.skills ?? []);
}

function removedSkills(
  baseOptions: BuildSystemPromptOptions,
  filteredOptions: BuildSystemPromptOptions,
): Skill[] {
  const keptPaths = new Set((filteredOptions.skills ?? []).map((skill) => skill.filePath));
  return (baseOptions.skills ?? []).filter(
    (skill) => !skill.disableModelInvocation && !keptPaths.has(skill.filePath),
  );
}

function skillEntry(skill: Skill): string | undefined {
  const section = formatSkillsForPrompt([skill]);
  const match = /<available_skills>\n([\s\S]+)\n<\/available_skills>/.exec(section);
  return match?.[1];
}

function contextFileEntry(file: { path: string; content: string }): string {
  return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
}

function blockedSkillFingerprintRemains(prompt: string, skill: Skill): boolean {
  return (
    prompt.includes(skill.filePath) ||
    prompt.includes(`<name>${skill.name}</name>`) ||
    (skill.description.length > 0 && prompt.includes(skill.description))
  );
}

export function filterSkillSystemPrompt(input: {
  currentSystemPrompt: string;
  baseOptions: BuildSystemPromptOptions;
  filteredOptions: BuildSystemPromptOptions;
}): SkillFilteredSystemPromptResult {
  const originalSkills = formatSkillsSection(input.baseOptions);
  const filteredSkills = formatSkillsSection(input.filteredOptions);
  if (originalSkills === filteredSkills) {
    return {
      systemPrompt: input.currentSystemPrompt,
      recognizedSkillSection: true,
    };
  }

  let protectedPrompt = input.currentSystemPrompt;
  const protectedSegments: Array<{ placeholder: string; text: string }> = [];

  function protectAt(text: string, index: number): void {
    let placeholder = `__CONTEXT_CONTROL_PROTECTED_${protectedSegments.length}__`;
    while (protectedPrompt.includes(placeholder)) placeholder += "_";
    protectedPrompt = `${protectedPrompt.slice(0, index)}${placeholder}${protectedPrompt.slice(index + text.length)}`;
    protectedSegments.push({ placeholder, text });
  }

  function protect(text: string | undefined, occurrence: "first" | "last"): void {
    if (!text) return;
    const index =
      occurrence === "first" ? protectedPrompt.indexOf(text) : protectedPrompt.lastIndexOf(text);
    if (index >= 0) protectAt(text, index);
  }

  function protectEvery(text: string): void {
    let index = protectedPrompt.indexOf(text);
    while (index >= 0) {
      protectAt(text, index);
      index = protectedPrompt.indexOf(text);
    }
  }

  protect(input.baseOptions.customPrompt, "first");
  protect(input.baseOptions.appendSystemPrompt, "last");
  for (const file of input.baseOptions.contextFiles ?? []) {
    protectEvery(contextFileEntry(file));
  }

  let recognizedSkillSection = true;
  if (originalSkills.length > 0 && protectedPrompt.includes(originalSkills)) {
    protectedPrompt = protectedPrompt.split(originalSkills).join(filteredSkills);
  } else {
    for (const skill of removedSkills(input.baseOptions, input.filteredOptions)) {
      const entry = skillEntry(skill);
      if (entry && protectedPrompt.includes(entry)) {
        protectedPrompt = protectedPrompt.split(entry).join("");
      } else if (blockedSkillFingerprintRemains(protectedPrompt, skill)) {
        recognizedSkillSection = false;
      }
    }
  }

  for (const segment of protectedSegments) {
    protectedPrompt = protectedPrompt.replace(segment.placeholder, segment.text);
  }

  return { systemPrompt: protectedPrompt, recognizedSkillSection };
}
