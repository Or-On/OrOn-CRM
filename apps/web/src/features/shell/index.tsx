"use client";

import {
  Activity,
  Bot,
  ContactRound,
  Columns3,
  MessagesSquare,
  Megaphone,
  MoonStar,
  PhoneCall,
  Sun,
  Workflow,
  LogOut,
  Settings,
  LayoutDashboard,
  Menu,
  Search,
  X,
  ArrowUpRight,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, Input } from "@or-on/ui";
import type { PublicSession } from "@or-on/auth";

import { product } from "../../branding";
import { crmMutation } from "../crm";
import { activeDestination, findDestinations, navigation } from "./navigation";

const icons = {
  overview: LayoutDashboard,
  inbox: MessagesSquare,
  contacts: ContactRound,
  pipeline: Columns3,
  campaigns: Megaphone,
  voice: PhoneCall,
  agents: Bot,
  flows: Workflow,
  settings: Settings,
  health: Activity,
};
const groups = ["Workspace", "Operations", "Workspace tools"] as const;

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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [sessionPending, setSessionPending] = useState(false);
  const [sessionError, setSessionError] = useState<string>();
  const commands = findDestinations(query);
  const active = activeDestination(pathname);

  useEffect(() => setThemeMounted(true), []);
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setQuery("");
        setCommandIndex(0);
        setPaletteOpen((value) => !value);
      }
      if (event.key === "Escape" && menuOpen) {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  function openPalette() {
    setQuery("");
    setCommandIndex(0);
    setPaletteOpen(true);
  }

  async function postSession(url: string, body: Record<string, string> = {}) {
    setSessionPending(true);
    setSessionError(undefined);
    try {
      await crmMutation(url, body);
      setMenuOpen(false);
      if (url.endsWith("logout")) router.replace("/login");
      router.refresh();
    } catch {
      setSessionError(
        "We couldn't confirm the session change. Refresh the page to check your current workspace.",
      );
    } finally {
      setSessionPending(false);
    }
  }

  function navigate(href: string) {
    setPaletteOpen(false);
    setMenuOpen(false);
    router.push(href);
  }

  if (session === undefined)
    return <div className="auth-layout">{children}</div>;

  return (
    <div className="shell">
      <a className="skip-link" href="#workspace-content">
        Skip to workspace
      </a>
      <header className="shell__mobile-header">
        <Link href="/" className="mobile-brand">
          {product.name}
        </Link>
        <Button
          aria-controls="workspace-navigation"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          onClick={() => setMenuOpen((value) => !value)}
          ref={menuButton}
          variant="quiet"
        >
          {menuOpen ? (
            <X aria-hidden="true" size={20} />
          ) : (
            <Menu aria-hidden="true" size={20} />
          )}
        </Button>
      </header>
      <aside
        id="workspace-navigation"
        aria-label="Workspace navigation"
        className={`shell__rail ${menuOpen ? "shell__rail--open" : ""}`}
      >
        <Link
          aria-label={`${product.name} overview`}
          className="brand"
          href="/"
        >
          <span aria-hidden="true" className="brand__mark">
            O<span />
          </span>
          <span className="brand__copy">
            <span className="brand__name">{product.name}</span>
            <span className="brand__phase">Customer operations</span>
          </span>
        </Link>
        <Button
          aria-label="Open command palette"
          className="shortcut"
          onClick={openPalette}
          variant="quiet"
        >
          <Search aria-hidden="true" size={15} />
          <span>Search workspace</span>
          <kbd>Ctrl K</kbd>
        </Button>
        <nav aria-label="Platform modules" className="nav">
          {groups.map((group) => (
            <div className="nav__group" key={group}>
              <p className="nav__group-label">{group}</p>
              {navigation
                .filter((item) => item.group === group)
                .map(({ href, icon, label }) => {
                  const Icon = icons[icon];
                  return (
                    <Link
                      aria-current={active === href ? "page" : undefined}
                      aria-label={label}
                      className={`nav__item ${active === href ? "nav__item--active" : ""}`}
                      href={href}
                      key={href}
                      onClick={() => setMenuOpen(false)}
                    >
                      <Icon aria-hidden="true" size={18} strokeWidth={1.7} />
                      <span className="nav__label">{label}</span>
                    </Link>
                  );
                })}
            </div>
          ))}
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
            <span dir="ltr">{session.user.email}</span>
            <Button
              aria-label="Sign out"
              disabled={sessionPending}
              onClick={() => void postSession("/api/auth/logout")}
              variant="quiet"
            >
              <LogOut aria-hidden="true" size={16} />
            </Button>
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
          </div>
          {sessionError ? (
            <p className="form-error" role="alert">
              {sessionError}
            </p>
          ) : null}
        </div>
      </aside>
      <div
        className="shell__main"
        id="workspace-content"
        tabIndex={-1}
        key={session.tenant.tenantId}
      >
        {children}
      </div>
      <Dialog
        description="Find a destination. Use the arrow keys to choose and Enter to open."
        onClose={() => setPaletteOpen(false)}
        open={paletteOpen}
        title="Your workspace, one shortcut away"
      >
        <Input
          autoFocus
          id="command-search"
          label="Find a destination"
          onChange={(event) => {
            setQuery(event.target.value);
            setCommandIndex(0);
          }}
          onKeyDown={(event) => {
            if (commands.length === 0) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setCommandIndex(
                (index) =>
                  (index +
                    (event.key === "ArrowDown" ? 1 : commands.length - 1)) %
                  commands.length,
              );
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const command = commands[commandIndex];
              if (command) navigate(command.href);
            }
          }}
          role="combobox"
          aria-autocomplete="list"
          aria-controls="command-results"
          aria-expanded="true"
          aria-activedescendant={
            commands[commandIndex]
              ? `command-${String(commandIndex)}`
              : undefined
          }
          placeholder="Inbox, contacts, calls…"
          value={query}
        />
        <div
          className="command-list"
          id="command-results"
          role="listbox"
          aria-label="Destinations"
        >
          {commands.map((item, index) => (
            <button
              className={`command-item ${index === commandIndex ? "command-item--active" : ""}`}
              role="option"
              aria-selected={index === commandIndex}
              id={`command-${String(index)}`}
              key={item.href}
              onMouseMove={() => setCommandIndex(index)}
              onClick={() => navigate(item.href)}
              type="button"
            >
              <span>
                {item.label}
                <small>{item.group}</small>
              </span>
              <ArrowUpRight aria-hidden="true" size={16} />
            </button>
          ))}
        </div>
        {commands.length === 0 ? (
          <p role="status" className="muted">
            No destinations found. Try “Inbox” or “Voice”.
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
