"use client";

import {
  Activity,
  Bot,
  Boxes,
  ContactRound,
  Columns3,
  MessagesSquare,
  Megaphone,
  MoonStar,
  PhoneCall,
  Sun,
  Workflow,
  LogOut,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button, Dialog, Input } from "@or-on/ui";
import type { PublicSession } from "@or-on/auth";

const navigation = [
  { href: "/", label: "Foundation", icon: Boxes, available: true },
  {
    href: "/system/health",
    label: "System health",
    icon: Activity,
    available: true,
  },
  { href: "/inbox", label: "Inbox", icon: MessagesSquare, available: true },
  {
    href: "/contacts",
    label: "Contacts",
    icon: ContactRound,
    available: true,
  },
  { href: "/pipelines", label: "Pipeline", icon: Columns3, available: true },
  { href: "/operations", label: "Campaigns", icon: Megaphone, available: true },
  { href: "/flows", label: "Flows", icon: Workflow, available: false },
  { href: "/voice", label: "Voice", icon: PhoneCall, available: false },
  { href: "/live", label: "Live agents", icon: Bot, available: false },
] as const;

function csrfToken(): string {
  const prefix = "or_on_csrf=";
  const value = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(prefix));
  return value === undefined
    ? ""
    : decodeURIComponent(value.slice(prefix.length));
}

export function AppShell({
  children,
  session,
}: {
  readonly children: ReactNode;
  readonly session: PublicSession | undefined;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [themeMounted, setThemeMounted] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sessionPending, setSessionPending] = useState(false);

  useEffect(() => setThemeMounted(true), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const commands = useMemo(
    () =>
      navigation.filter((item) =>
        item.label.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  );

  async function postSession(url: string, body?: Record<string, string>) {
    setSessionPending(true);
    try {
      const init: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken(),
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await fetch(url, init);
      if (!response.ok) throw new Error("session operation failed");
      router.refresh();
    } finally {
      setSessionPending(false);
    }
  }

  if (session === undefined) {
    return <div className="auth-layout">{children}</div>;
  }

  return (
    <div className="shell">
      <aside aria-label="Primary navigation" className="shell__rail">
        <Link aria-label="Or-On Platform foundation" className="brand" href="/">
          <span aria-hidden="true" className="brand__mark">
            O
          </span>
          <span className="brand__copy">
            <span className="brand__name">Or-On Platform</span>
            <span className="brand__phase">CRM operations</span>
          </span>
        </Link>

        <nav aria-label="Platform modules" className="nav">
          {navigation.map(({ available, href, icon: Icon, label }) =>
            available ? (
              <Link
                aria-current={pathname === href ? "page" : undefined}
                className={`nav__item ${pathname === href ? "nav__item--active" : ""}`}
                href={href}
                key={href}
              >
                <Icon aria-hidden="true" size={17} />
                <span className="nav__label">{label}</span>
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className="nav__item nav__item--disabled"
                key={href}
              >
                <Icon aria-hidden="true" size={17} />
                <span className="nav__label">{label}</span>
                <span className="nav__soon">Planned</span>
              </span>
            ),
          )}
        </nav>

        <div className="shell__rail-footer">
          <label className="tenant-switcher" htmlFor="active-tenant">
            <span>Workspace</span>
            <select
              disabled={sessionPending}
              id="active-tenant"
              onChange={(event) =>
                void postSession("/api/auth/tenant", {
                  tenantId: event.target.value,
                })
              }
              value={session.tenant.tenantId}
            >
              {session.memberships.map((membership) => (
                <option key={membership.tenantId} value={membership.tenantId}>
                  {membership.tenantName} · {membership.role}
                </option>
              ))}
            </select>
          </label>
          <div className="identity-summary">
            <span>{session.user.email}</span>
            <Button
              aria-label="Sign out"
              disabled={sessionPending}
              onClick={() =>
                void postSession("/api/auth/logout").then(() =>
                  router.replace("/login"),
                )
              }
              variant="quiet"
            >
              <LogOut aria-hidden="true" size={15} />
            </Button>
          </div>
          <Button
            aria-label={
              themeMounted
                ? `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`
                : "Toggle color theme"
            }
            disabled={!themeMounted}
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
            variant="quiet"
          >
            {themeMounted && resolvedTheme === "dark" ? (
              <Sun aria-hidden="true" size={16} />
            ) : (
              <MoonStar aria-hidden="true" size={16} />
            )}
          </Button>
          <Button
            className="shortcut"
            onClick={() => setPaletteOpen(true)}
            variant="quiet"
          >
            <span>Commands</span>
            <kbd>Ctrl K</kbd>
          </Button>
        </div>
      </aside>

      <div className="shell__main">{children}</div>

      <Dialog
        description="Navigate implemented platform surfaces. Planned modules remain disabled."
        onClose={() => setPaletteOpen(false)}
        open={paletteOpen}
        title="Command palette"
      >
        <Input
          autoFocus
          id="command-search"
          label="Find a destination"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search modules"
          value={query}
        />
        <div className="command-list">
          {commands.map((item) => (
            <button
              className="command-item"
              disabled={!item.available}
              key={item.href}
              onClick={() => {
                if (item.available) router.push(item.href);
                setPaletteOpen(false);
              }}
              type="button"
            >
              <span>{item.label}</span>
              <span>{item.available ? "Open" : "Planned"}</span>
            </button>
          ))}
        </div>
      </Dialog>
    </div>
  );
}
