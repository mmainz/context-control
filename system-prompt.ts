import {
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
  type Skill,
} from "@earendil-works/pi-coding-agent";

export interface FilteredSystemPromptInput {
  currentSystemPrompt: string;
  baseOptions: BuildSystemPromptOptions;
  filteredOptions: BuildSystemPromptOptions;
}

export interface FilteredSystemPromptResult {
  systemPrompt: string;
  preservedChainedChanges: boolean;
}

export interface ProjectedSystemPromptResult {
  systemPrompt: string;
  recognizedResourceSections: boolean;
}

const CONTEXT_HEADER =
  "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
const CONTEXT_FOOTER = "</project_context>\n";
const GENERATED_CONTEXT_PATTERN =
  /\n\n<project_context>\n[\s\S]*?<\/project_context>\n/g;
const GENERATED_SKILLS_PATTERN =
  /\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/g;

export function formatContextFile(file: {
  path: string;
  content: string;
}): string {
  return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
}

export function formatContextSection(
  options: BuildSystemPromptOptions,
): string {
  const contextFiles = options.contextFiles ?? [];
  if (contextFiles.length === 0) return "";

  return `${CONTEXT_HEADER}${contextFiles.map(formatContextFile).join("")}${CONTEXT_FOOTER}`;
}

export function formatSkillsSection(options: BuildSystemPromptOptions): string {
  const hasReadTool =
    options.selectedTools === undefined ||
    options.selectedTools.includes("read");
  if (!hasReadTool) return "";

  return formatSkillsForPrompt(options.skills ?? []);
}

function replaceSection(
  prompt: string,
  originalSection: string,
  filteredSection: string,
): { prompt: string; replaced: boolean } {
  if (originalSection === filteredSection) {
    return { prompt, replaced: true };
  }

  if (!prompt.includes(originalSection)) {
    return { prompt, replaced: false };
  }

  return {
    prompt: prompt.split(originalSection).join(filteredSection),
    replaced: true,
  };
}

function removedContextFiles(
  baseOptions: BuildSystemPromptOptions,
  filteredOptions: BuildSystemPromptOptions,
): Array<{ path: string; content: string }> {
  const keptPaths = new Set(
    (filteredOptions.contextFiles ?? []).map((file) => file.path),
  );
  return (baseOptions.contextFiles ?? []).filter(
    (file) => !keptPaths.has(file.path),
  );
}

function removedSkills(
  baseOptions: BuildSystemPromptOptions,
  filteredOptions: BuildSystemPromptOptions,
): Skill[] {
  const keptPaths = new Set(
    (filteredOptions.skills ?? []).map((skill) => skill.filePath),
  );
  return (baseOptions.skills ?? []).filter(
    (skill) => !skill.disableModelInvocation && !keptPaths.has(skill.filePath),
  );
}

function skillEntry(skill: Skill): string | undefined {
  const section = formatSkillsForPrompt([skill]);
  const match = /<available_skills>\n([\s\S]+)\n<\/available_skills>/.exec(
    section,
  );
  return match?.[1];
}

function removeResourceEntries(
  prompt: string,
  baseOptions: BuildSystemPromptOptions,
  filteredOptions: BuildSystemPromptOptions,
): { prompt: string; removedAll: boolean } {
  let result = prompt;
  let removedAll = true;

  for (const file of removedContextFiles(baseOptions, filteredOptions)) {
    const entry = formatContextFile(file);
    if (!result.includes(entry)) {
      if (result.includes(file.path)) removedAll = false;
      continue;
    }
    result = result.split(entry).join("");
  }

  for (const skill of removedSkills(baseOptions, filteredOptions)) {
    const entry = skillEntry(skill);
    if (!entry || !result.includes(entry)) {
      if (result.includes(skill.filePath)) removedAll = false;
      continue;
    }
    result = result.split(entry).join("");
  }

  return { prompt: result, removedAll };
}

export function projectSystemPromptResources(input: {
  currentSystemPrompt: string;
  baseOptions: BuildSystemPromptOptions;
  filteredOptions: BuildSystemPromptOptions;
}): ProjectedSystemPromptResult {
  const expectedContext = formatContextSection(input.filteredOptions);
  const expectedSkills = formatSkillsSection(input.filteredOptions);
  let protectedPrompt = input.currentSystemPrompt;
  const protectedSegments: Array<{ placeholder: string; text: string }> = [];

  function protect(text: string | undefined, occurrence: "first" | "last") {
    if (!text) return undefined;
    const index =
      occurrence === "first"
        ? protectedPrompt.indexOf(text)
        : protectedPrompt.lastIndexOf(text);
    if (index < 0) return undefined;
    let placeholder = `__CONTEXT_CONTROL_PROTECTED_${protectedSegments.length}__`;
    while (protectedPrompt.includes(placeholder)) placeholder += "_";
    protectedPrompt = `${protectedPrompt.slice(0, index)}${placeholder}${protectedPrompt.slice(index + text.length)}`;
    protectedSegments.push({ placeholder, text });
    return placeholder;
  }

  protect(input.baseOptions.customPrompt, "first");
  const appendPlaceholder = protect(
    input.baseOptions.appendSystemPrompt,
    "last",
  );
  const contextPaths = (input.baseOptions.contextFiles ?? []).map(
    (file) => file.path,
  );
  const skillPaths = (input.baseOptions.skills ?? [])
    .filter((skill) => !skill.disableModelInvocation)
    .map((skill) => skill.filePath);
  const withoutContext = protectedPrompt.replace(
    GENERATED_CONTEXT_PATTERN,
    (section) =>
      contextPaths.some((resourcePath) => section.includes(resourcePath))
        ? ""
        : section,
  );
  const withoutResources = withoutContext.replace(
    GENERATED_SKILLS_PATTERN,
    (section) =>
      skillPaths.some((resourcePath) => section.includes(resourcePath))
        ? ""
        : section,
  );
  const knownPaths = [...contextPaths, ...skillPaths];
  const recognizedResourceSections = !knownPaths.some((resourcePath) =>
    withoutResources.includes(resourcePath),
  );
  const insertion = `${expectedContext}${expectedSkills}`;
  const appendMarker = appendPlaceholder ? `\n\n${appendPlaceholder}` : "";
  const appendIndex =
    appendMarker.length > 0 ? withoutResources.lastIndexOf(appendMarker) : -1;
  let systemPrompt =
    appendIndex >= 0
      ? `${withoutResources.slice(0, appendIndex)}${insertion}${withoutResources.slice(appendIndex)}`
      : `${withoutResources}${insertion}`;
  for (const segment of protectedSegments) {
    systemPrompt = systemPrompt.replace(segment.placeholder, segment.text);
  }

  return { systemPrompt, recognizedResourceSections };
}

export function buildFilteredSystemPrompt(
  input: FilteredSystemPromptInput,
): FilteredSystemPromptResult {
  const originalContext = formatContextSection(input.baseOptions);
  const filteredContext = formatContextSection(input.filteredOptions);
  const contextResult = replaceSection(
    input.currentSystemPrompt,
    originalContext,
    filteredContext,
  );
  const originalSkills = formatSkillsSection(input.baseOptions);
  const filteredSkills = formatSkillsSection(input.filteredOptions);
  const skillsResult = replaceSection(
    contextResult.prompt,
    originalSkills,
    filteredSkills,
  );

  if (contextResult.replaced && skillsResult.replaced) {
    return {
      systemPrompt: skillsResult.prompt,
      preservedChainedChanges: true,
    };
  }

  const fallback = removeResourceEntries(
    input.currentSystemPrompt,
    input.baseOptions,
    input.filteredOptions,
  );
  return {
    systemPrompt: fallback.prompt,
    preservedChainedChanges: fallback.removedAll,
  };
}
