import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Surface } from "@or-on/ui";

import { currentPublicSession } from "../../features/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if ((await currentPublicSession()) !== undefined) redirect("/");
  return (
    <main className="login-page">
      <Surface className="login-card" level="raised">
        <span className="eyebrow">Canonical identity</span>
        <h1>Welcome to Or-On</h1>
        <p>Sign in to a tenant-scoped operator session.</p>
        <LoginForm />
      </Surface>
    </main>
  );
}
