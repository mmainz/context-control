export interface ResourceRef {
  id: string;
  path: string;
  label?: string;
  group?: string;
}

export type ResourcePolicy =
  | { mode: "all" }
  | { mode: "none" }
  | { mode: "blocklist"; refs: ResourceRef[] }
  | { mode: "allowlist"; refs: ResourceRef[] };

export interface RepositoryIdentity {
  id: string;
  label: string;
  configKey: string;
  worktreeRoot?: string;
  gitCommonDir?: string;
}

export interface ContextControlConfig {
  version: 1;
  repository: {
    id: string;
    label: string;
    gitCommonDir?: string;
  };
  contextFiles: ResourcePolicy;
  skills: ResourcePolicy;
}

export interface RuntimeConfig {
  repository: RepositoryIdentity;
  configPath: string;
  config: ContextControlConfig;
}

export interface ResourceItem {
  ref: ResourceRef;
  sourcePath: string;
  description?: string;
}

export type ResourceKind = "contextFiles" | "skills";
