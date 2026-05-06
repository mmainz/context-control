import type { ResourceItem, ResourcePolicy, ResourceRef } from "./types";

function uniqueRefs(refs: ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  const unique: ResourceRef[] = [];

  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    unique.push(ref);
  }

  return unique;
}

export function policyRefs(policy: ResourcePolicy): ResourceRef[] {
  return "refs" in policy ? policy.refs : [];
}

export function applyResourcePolicy<T extends ResourceItem>(
  items: T[],
  policy: ResourcePolicy,
): T[] {
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

export function createPolicy(mode: "all" | "none"): ResourcePolicy;
export function createPolicy(
  mode: "blocklist" | "allowlist",
  refs: ResourceRef[],
): ResourcePolicy;
export function createPolicy(
  mode: ResourcePolicy["mode"],
  refs: ResourceRef[] = [],
): ResourcePolicy {
  switch (mode) {
    case "all":
      return { mode: "all" };
    case "none":
      return { mode: "none" };
    case "blocklist":
      return { mode: "blocklist", refs };
    case "allowlist":
      return { mode: "allowlist", refs };
  }
}

export function countEnabled(
  items: ResourceItem[],
  policy: ResourcePolicy,
): number {
  return applyResourcePolicy(items, policy).length;
}

export function staleRefs(
  items: ResourceItem[],
  policy: ResourcePolicy,
): ResourceRef[] {
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
  const staleExistingRefs = existingRefs.filter(
    (ref) => !currentIds.has(ref.id),
  );
  return uniqueRefs([...selectedRefs, ...staleExistingRefs]);
}

export function pruneStaleRefs(
  items: ResourceItem[],
  policy: ResourcePolicy,
): ResourcePolicy {
  if (!("refs" in policy)) return policy;

  const currentIds = new Set(items.map((item) => item.ref.id));
  const refs = policy.refs.filter((ref) => currentIds.has(ref.id));
  return { mode: policy.mode, refs };
}
