import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

import { applyResourcePolicy } from "./filtering";
import { isProjectResource, pickSkills, skillsFromOptions } from "./resources";
import type { ResourceItem, RuntimeConfig } from "./types";

export interface EffectiveSkillSelection {
  all: ResourceItem[];
  project: ResourceItem[];
  external: ResourceItem[];
  enabled: ResourceItem[];
  blocked: ResourceItem[];
  explicitOnly: ResourceItem[];
  effectiveOptions: BuildSystemPromptOptions;
}

function difference(items: ResourceItem[], kept: ResourceItem[]): ResourceItem[] {
  const keptIds = new Set(kept.map((item) => item.ref.id));
  return items.filter((item) => !keptIds.has(item.ref.id));
}

export async function selectEffectiveSkills(
  options: BuildSystemPromptOptions,
  runtime: RuntimeConfig,
): Promise<EffectiveSkillSelection> {
  const allSkillItems = await skillsFromOptions(options, runtime.repository, {
    includeExplicitOnly: true,
  });
  const skillItems = allSkillItems.filter((item) => !item.explicitOnly);
  const explicitSkillItems = allSkillItems.filter((item) => item.explicitOnly);
  const projectSkillItems = skillItems.filter(isProjectResource);
  const externalSkillItems = skillItems.filter((item) => !isProjectResource(item));
  const enabledProjectSkillItems = applyResourcePolicy(projectSkillItems, runtime.config.skills);
  const enabledSkillItems = [...externalSkillItems, ...enabledProjectSkillItems];

  return {
    all: skillItems,
    project: projectSkillItems,
    external: externalSkillItems,
    enabled: enabledSkillItems,
    blocked: difference(projectSkillItems, enabledProjectSkillItems),
    explicitOnly: explicitSkillItems,
    effectiveOptions: {
      ...options,
      skills: pickSkills(options.skills, enabledSkillItems),
    },
  };
}
