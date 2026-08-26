import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <AppShell
      user={{ name: user.name || user.email, email: user.email, role: user.role }}
    >
      {children}
    </AppShell>
  );
}
