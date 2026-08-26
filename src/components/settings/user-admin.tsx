"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { Panel, Badge } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { ErrorNote, Field, OkNote, Select, TextInput } from "@/components/settings/field";
import { createUserAction, setUserActiveAction, setUserRoleAction } from "@/server/settings";
import type { Role } from "@/server/db/schema";

/**
 * Members of the organisation (spec §25).
 *
 * Role changes take effect on the next request, not the next sign-in: the
 * session row is re-read on every request, so demoting someone removes their
 * access immediately rather than whenever their token happens to expire.
 */

export type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};

const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "designer", label: "Designer" },
  { value: "reviewer", label: "Reviewer" },
  { value: "viewer", label: "Viewer" },
];

export function UserAdmin({
  users,
  currentUserId,
  editable,
}: {
  users: UserRow[];
  currentUserId: string;
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", role: "viewer" as Role, password: "" });

  const changeRole = (userId: string, role: Role) => {
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await setUserRoleAction({ userId, role });
      if (res.ok) router.refresh();
      else setError(res.error);
    });
  };

  const changeActive = (userId: string, active: boolean) => {
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await setUserActiveAction({ userId, active });
      if (res.ok) router.refresh();
      else setError(res.error);
    });
  };

  const create = () => {
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await createUserAction(form);
      if (res.ok) {
        setNotice(
          `${form.email} was added as ${form.role}. Give them the password you set; there is no email delivery in this deployment.`,
        );
        setForm({ email: "", name: "", role: "viewer", password: "" });
        setAdding(false);
        router.refresh();
      } else setError(res.error);
    });
  };

  return (
    <Panel
      title="Members"
      description="Everyone with access to this organisation's products, cards and exports."
      actions={
        editable && !adding ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <UserPlus size={13} aria-hidden />
            Add member
          </Button>
        ) : null
      }
    >
      {adding && editable ? (
        <div className="border-b border-ink-800 bg-ink-900/40 p-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="Email" htmlFor="newEmail">
              <TextInput
                id="newEmail"
                type="email"
                autoComplete="off"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Name" htmlFor="newName">
              <TextInput
                id="newName"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Role" htmlFor="newRole">
              <Select
                id="newRole"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Initial password"
              htmlFor="newPassword"
              hint="At least 12 characters, mixed case, one digit. They should change it after signing in."
            >
              <TextInput
                id="newPassword"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={create} disabled={pending}>
              {pending ? "Adding…" : "Add member"}
            </Button>
          </div>
        </div>
      ) : null}

      {error || notice ? (
        <div className="border-b border-ink-800 p-4">
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {notice ? <OkNote>{notice}</OkNote> : null}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
              <th scope="col" className="px-4 py-2 font-medium">
                Person
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Role
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                State
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Last signed in
              </th>
              <th scope="col" className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-ink-800/60 last:border-0">
                <th scope="row" className="px-4 py-2.5 text-left font-normal">
                  <div className="text-[13px] text-ink-100">{u.name || u.email}</div>
                  <div className="text-[11px] text-ink-500">{u.email}</div>
                </th>
                <td className="px-4 py-2.5">
                  {editable ? (
                    <>
                      <label htmlFor={`role-${u.id}`} className="sr-only">
                        Role for {u.email}
                      </label>
                      <Select
                        id={`role-${u.id}`}
                        value={u.role}
                        disabled={pending}
                        className="w-36"
                        onChange={(e) => changeRole(u.id, e.target.value as Role)}
                      >
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </Select>
                    </>
                  ) : (
                    <Badge tone="neutral">{u.role}</Badge>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {u.active ? (
                    <Badge tone="ok">active</Badge>
                  ) : (
                    <Badge tone="warning">deactivated</Badge>
                  )}
                  {u.id === currentUserId ? (
                    <span className="ml-2 text-[11px] text-ink-500">you</span>
                  ) : null}
                </td>
                <td className="numeric px-4 py-2.5 text-[12px] text-ink-400">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {editable && u.id !== currentUserId ? (
                    <Button
                      size="sm"
                      variant={u.active ? "ghost" : "outline"}
                      disabled={pending}
                      onClick={() => changeActive(u.id, !u.active)}
                    >
                      {u.active ? "Deactivate" : "Reactivate"}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!editable ? (
        <p className="border-t border-ink-800 px-4 py-3 text-[12px] text-ink-500">
          Your role can see who has access but cannot change it. An admin can.
        </p>
      ) : null}
    </Panel>
  );
}
