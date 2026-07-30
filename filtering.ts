import type { ResourceItem, ResourcePolicy, ResourceRef } from "./types";

export function policyRefs(policy: ResourcePolicy): ResourceRef[] {
  return "refs" in policy ? policy.refs : [];
}

export function applyResourcePolicy(items: ResourceItem[], policy: ResourcePolicy): ResourceItem[] {
  switch (policy.mode) {
    case "all":
      return items;
    case "none":
      return [];
    case "blocklist": {
      const blockedIds = new Set(policy.refs.map((ref) => ref.id));
      return items.filter((item) => !blockedIds.has(item.ref.id));
    }
    case "allowlist": {
      const allowedIds = new Set(policy.refs.map((ref) => ref.id));
      return items.filter((item) => allowedIds.has(item.ref.id));
    }
  }
}

export function countEnabled(items: ResourceItem[], policy: ResourcePolicy): number {
  return applyResourcePolicy(items, policy).length;
}

export function createPolicy(
  mode: ResourcePolicy["mode"],
  refs: ResourceRef[] = [],
): ResourcePolicy {
  if (mode === "all" || mode === "none") return { mode };
  return { mode, refs };
}

export function staleRefs(items: ResourceItem[], policy: ResourcePolicy): ResourceRef[] {
  if (!("refs" in policy)) return [];
  const currentIds = new Set(items.map((item) => item.ref.id));
  return policy.refs.filter((ref) => !currentIds.has(ref.id));
}

export function preserveStaleRefs(
  items: ResourceItem[],
  selectedRefs: ResourceRef[],
  existingRefs: ResourceRef[],
): ResourceRef[] {
  const currentIds = new Set(items.map((item) => item.ref.id));
  const staleExistingRefs = existingRefs.filter((ref) => !currentIds.has(ref.id));
  const merged = new Map<string, ResourceRef>();
  for (const ref of [...selectedRefs, ...staleExistingRefs]) {
    merged.set(ref.id, ref);
  }
  return [...merged.values()];
}

export function pruneStaleRefs(items: ResourceItem[], policy: ResourcePolicy): ResourcePolicy {
  if (!("refs" in policy)) return policy;
  const currentIds = new Set(items.map((item) => item.ref.id));
  const refs = policy.refs.filter((ref) => currentIds.has(ref.id));
  return { mode: policy.mode, refs };
}
