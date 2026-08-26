import type { Role } from "@/server/db/schema";

/**
 * RBAC — spec §25. Four roles, one capability table. Every server action and
 * route handler calls `can()`; nothing relies on the UI having hidden a button.
 */

export const CAPABILITIES = [
  "product.read",
  "product.write",
  "product.import",
  "design.read",
  "design.write",
  "design.submit",
  "design.approve",
  "template.read",
  "template.write",
  "export.proof",
  "export.production",
  "export.override_blocking",
  "asset.upload",
  "gs1.read",
  "gs1.configure",
  "gs1.sync",
  "org.manage",
  "audit.read",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const MATRIX: Record<Role, Capability[]> = {
  admin: [...CAPABILITIES],
  designer: [
    "product.read",
    "product.write",
    "product.import",
    "design.read",
    "design.write",
    "design.submit",
    "template.read",
    "template.write",
    "export.proof",
    "export.production",
    "asset.upload",
    "gs1.read",
    "gs1.sync",
  ],
  reviewer: [
    "product.read",
    "design.read",
    "design.approve",
    "template.read",
    "export.proof",
    "gs1.read",
    "audit.read",
  ],
  viewer: ["product.read", "design.read", "template.read", "export.proof", "gs1.read"],
};

export function can(role: Role, cap: Capability): boolean {
  return MATRIX[role]?.includes(cap) ?? false;
}

export function capabilitiesFor(role: Role): Capability[] {
  return MATRIX[role] ?? [];
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  designer: "Designer",
  reviewer: "Reviewer",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Full access, including GS1 credentials, org settings and blocking-error overrides.",
  designer: "Creates and edits cards, imports product data, runs proofs and production exports.",
  reviewer: "Reviews and approves artwork. Cannot edit designs or run production exports.",
  viewer: "Read-only access to products, designs and proofs.",
};
