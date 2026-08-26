"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { loginAction, type LoginState } from "@/server/auth/actions";
import { Button } from "@/components/ui/button";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="lg" className="mt-6 w-full justify-center" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </Button>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState<LoginState, FormData>(loginAction, {});

  return (
    <form action={action} className="mt-8">
      <input type="hidden" name="next" value={next} />

      <label className="block text-xs font-medium uppercase tracking-wider text-ink-400" htmlFor="email">
        Email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="username"
        required
        autoFocus
        className="mt-1.5 block h-10 w-full rounded-md border border-ink-700 bg-ink-850 px-3 text-sm text-ink-50 placeholder:text-ink-500 focus:border-brand-500"
        placeholder="you@company.com"
      />

      <label
        className="mt-5 block text-xs font-medium uppercase tracking-wider text-ink-400"
        htmlFor="password"
      >
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        className="mt-1.5 block h-10 w-full rounded-md border border-ink-700 bg-ink-850 px-3 text-sm text-ink-50 focus:border-brand-500"
      />

      {state.error ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-flag-800 bg-flag-900/30 px-3 py-2 text-sm text-flag-200"
        >
          {state.error}
        </p>
      ) : null}

      <Submit />
    </form>
  );
}
