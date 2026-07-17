import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

import { applyResourcePolicy } from "./filtering";
import {
  contextFilesFromOptions,
  isProjectResource,
  pickContextFiles,
  pickSkills,
  skillsFromOptions,
} from "./resources";
import type { ResourceItem, RuntimeConfig } from "./types";

export interface EffectiveContextSelection {
  contextFiles: {
    all: ResourceItem[];
    project: ResourceItem[];
    external: ResourceItem[];
    enabled: ResourceItem[];
    blocked: ResourceItem[];
  };
  skills: {
    all: ResourceItem[];
    project: ResourceItem[];
    external: ResourceItem[];
    enabled: ResourceItem[];
    blocked: ResourceItem[];
    explicitOnly: ResourceItem[];
  };
  filteredOptions: BuildSystemPromptOptions;
}

function difference(
  items: ResourceItem[],
  kept: ResourceItem[],
): ResourceItem[] {
  const keptIds = new Set(kept.map((item) => item.ref.id));
  return items.filter((item) => !keptIds.has(item.ref.id));
}

export async function selectEffectiveContext(
  options: BuildSystemPromptOptions,
  runtime: RuntimeConfig,
): Promise<EffectiveContextSelection> {
  const contextItems = await contextFilesFromOptions(
    options,
    runtime.repository,
  );
  const allSkillItems = await skillsFromOptions(options, runtime.repository, {
    includeExplicitOnly: true,
  });
  const skillItems = allSkillItems.filter((item) => !item.explicitOnly);
  const explicitSkillItems = allSkillItems.filter((item) => item.explicitOnly);

  const projectContextItems = contextItems.filter(isProjectResource);
  const externalContextItems = contextItems.filter(
    (item) => !isProjectResource(item),
  );
  const enabledProjectContextItems = applyResourcePolicy(
    projectContextItems,
    runtime.config.contextFiles,
  );
  const enabledContextItems = [
    ...externalContextItems,
    ...enabledProjectContextItems,
  ];

  const projectSkillItems = skillItems.filter(isProjectResource);
  const externalSkillItems = skillItems.filter(
    (item) => !isProjectResource(item),
  );
  const enabledProjectSkillItems = applyResourcePolicy(
    projectSkillItems,
    runtime.config.skills,
  );
  const enabledSkillItems = [
    ...externalSkillItems,
    ...enabledProjectSkillItems,
  ];

  return {
    contextFiles: {
      all: contextItems,
      project: projectContextItems,
      external: externalContextItems,
      enabled: enabledContextItems,
      blocked: difference(projectContextItems, enabledProjectContextItems),
    },
    skills: {
      all: skillItems,
      project: projectSkillItems,
      external: externalSkillItems,
      enabled: enabledSkillItems,
      blocked: difference(projectSkillItems, enabledProjectSkillItems),
      explicitOnly: explicitSkillItems,
    },
    filteredOptions: {
      ...options,
      contextFiles: pickContextFiles(options.contextFiles, enabledContextItems),
      skills: pickSkills(options.skills, enabledSkillItems),
    },
  };
}
