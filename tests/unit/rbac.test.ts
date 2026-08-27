import { describe, expect, it } from "vitest";
import { CAPABILITIES, ROLE_DESCRIPTIONS, ROLE_LABELS, can, capabilitiesFor } from "@/server/auth/rbac";
import { ROLES, type Role } from "@/server/db/schema";

/**
 * The capability matrix is the whole authorisation model, so it is pinned rather
 * than described. A capability quietly appearing on Viewer is the kind of change
 * that passes review and should not.
 */
describe("RBAC matrix", () => {
  it("covers every role", () => {
    for (const role of ROLES) {
      expect(capabilitiesFor(role).length).toBeGreaterThan(0);
      expect(ROLE_LABELS[role]).toBeTruthy();
      expect(ROLE_DESCRIPTIONS[role]).toBeTruthy();
    }
  });

  it("gives Admin everything and nobody else everything", () => {
    expect(capabilitiesFor("admin").length).toBe(CAPABILITIES.length);
    for (const role of ROLES.filter((r) => r !== "admin")) {
      expect(capabilitiesFor(role).length).toBeLessThan(CAPABILITIES.length);
    }
  });

  it("reserves the dangerous capabilities to Admin alone", () => {
    // Overriding a blocking preflight finding sends artwork to a press that the
    // system said was not fit to print. Configuring GS1 touches stored
    // credentials. Neither belongs to anyone else.
    for (const cap of ["export.override_blocking", "gs1.configure", "org.manage"] as const) {
      expect(can("admin", cap)).toBe(true);
      for (const role of ROLES.filter((r) => r !== "admin")) {
        expect(can(role, cap)).toBe(false);
      }
    }
  });

  it("keeps Reviewer able to approve but not to edit or print", () => {
    expect(can("reviewer", "design.approve")).toBe(true);
    expect(can("reviewer", "design.write")).toBe(false);
    expect(can("reviewer", "export.production")).toBe(false);
  });

  it("keeps Designer able to edit and print but not to approve their own work", () => {
    expect(can("designer", "design.write")).toBe(true);
    expect(can("designer", "export.production")).toBe(true);
    // Separation of duties: the person who made the artwork does not sign it off.
    expect(can("designer", "design.approve")).toBe(false);
  });

  it("keeps Viewer read-only", () => {
    const viewer = capabilitiesFor("viewer");
    for (const cap of viewer) {
      expect(cap.endsWith(".read") || cap === "export.proof").toBe(true);
    }
    expect(can("viewer", "design.write")).toBe(false);
    expect(can("viewer", "product.write")).toBe(false);
    expect(can("viewer", "export.production")).toBe(false);
  });

  it("refuses an unknown role rather than defaulting open", () => {
    expect(can("superuser" as Role, "org.manage")).toBe(false);
    expect(capabilitiesFor("superuser" as Role)).toEqual([]);
  });

  it("has no capability that no role can exercise", () => {
    for (const cap of CAPABILITIES) {
      expect(ROLES.some((r) => can(r, cap))).toBe(true);
    }
  });
});
