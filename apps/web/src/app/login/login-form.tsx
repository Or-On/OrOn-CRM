"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import { Button, Input } from "@or-on/ui";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
        }),
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        setError(result.error ?? "Sign in failed");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Authentication is temporarily unavailable");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="login-form" onSubmit={(event) => void submit(event)}>
      <Input
        autoComplete="email"
        id="email"
        label="Email"
        name="email"
        required
        type="email"
      />
      <Input
        autoComplete="current-password"
        id="password"
        label="Password"
        name="password"
        required
        type="password"
      />
      {error === undefined ? null : (
        <p aria-live="polite" className="form-error">
          {error}
        </p>
      )}
      <Button disabled={pending} type="submit">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
