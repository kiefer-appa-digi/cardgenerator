import { asc, eq } from "drizzle-orm";
import { db, users } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { PageHeader, Stat } from "@/components/ui/panel";
import { CapabilityMatrix } from "@/components/settings/capability-matrix";
import { UserAdmin, type UserRow } from "@/components/settings/user-admin";
import type { Role } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export default async function UsersSettingsPage() {
  const user = await requireUser();
  const editable = can(user.role, "org.manage");

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      active: users.active,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.orgId, user.orgId))
    .orderBy(asc(users.email));

  const list: UserRow[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role as Role,
    active: r.active,
    lastLoginAt: r.lastLoginAt ? r.lastLoginAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));

  const active = list.filter((u) => u.active);
  const admins = active.filter((u) => u.role === "admin");

  return (
    <>
      <PageHeader
        title="Users &amp; roles"
        description="Four roles, one capability table. Every server action checks it; the interface never grants access by showing a button."
        meta={
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Members" value={list.length} sub={`${active.length} active`} />
            <Stat
              label="Admins"
              value={admins.length}
              tone={admins.length === 1 ? "warning" : "default"}
              sub={
                admins.length === 1
                  ? "a single admin is a single point of failure"
                  : "can change settings and credentials"
              }
            />
            <Stat
              label="Designers"
              value={active.filter((u) => u.role === "designer").length}
              sub="edit cards, run exports"
            />
            <Stat
              label="Reviewers"
              value={active.filter((u) => u.role === "reviewer").length}
              sub="approve artwork"
            />
          </div>
        }
      />

      <div className="space-y-6 p-8">
        <UserAdmin users={list} currentUserId={user.id} editable={editable} />
        <CapabilityMatrix />
      </div>
    </>
  );
}
