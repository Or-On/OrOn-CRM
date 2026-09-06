"use client";
import { useTranslations } from "next-intl";

import {
  Activity,
  PanelLeftClose,
  PanelLeftOpen,
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

import { LanguageControl } from "../../i18n/language-control";
import { crmMutation } from "../crm";
import { BrandLockup } from "../brand";
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
  const t = useTranslations();
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [themeMounted, setThemeMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const navigationRail = useRef<HTMLElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [sessionPending, setSessionPending] = useState(false);
  const [sessionError, setSessionError] = useState<string>();
  const navKey = (href: string, icon: string) =>
    href === "/voice/campaigns" ? "voiceCampaigns" : icon;
  const groupLabel = (group: string) =>
    t(
      `shell.${group === "Workspace" ? "workspace" : group === "Operations" ? "operations" : "tools"}`,
    );
  const commands = findDestinations(
    query,
    (item) =>
      `${t(`shell.${navKey(item.href, item.icon)}`)} ${groupLabel(item.group)} ${item.label}`,
  );
  const active = activeDestination(pathname);

  useEffect(() => setThemeMounted(true), []);
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    const drawerQuery = window.matchMedia("(max-width: 62rem)");
    const closeAtDesktop = (event: MediaQueryListEvent) => {
      if (!event.matches) setMenuOpen(false);
    };
    drawerQuery.addEventListener("change", closeAtDesktop);
    return () => drawerQuery.removeEventListener("change", closeAtDesktop);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const rail = navigationRail.current;
    if (!rail) return;
    const focusable = Array.from(
      rail.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable.at(0);
    const last = focusable.at(-1);
    const frame = requestAnimationFrame(() => first?.focus());
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    rail.addEventListener("keydown", trapFocus);
    return () => {
      cancelAnimationFrame(frame);
      rail.removeEventListener("keydown", trapFocus);
    };
  }, [menuOpen]);
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
      setSessionError(t("shell.sessionFailed"));
    } finally {
      setSessionPending(false);
    }
  }

  function navigate(href: string) {
    setPaletteOpen(false);
    setMenuOpen(false);
    router.push(href);
  }

  if (session === undefined || /^\/(en|he)(\/|$)/u.test(pathname))
    return <div className="auth-layout">{children}</div>;

  return (
    <div className={`shell ${collapsed ? "shell--compact" : ""}`}>
      <a className="skip-link" href="#workspace-content">
        {t("shell.skip")}
      </a>
      <header className="shell__mobile-header">
        <Link
          aria-label={t("shell.brandHome")}
          href="/"
          className="mobile-brand"
        >
          <BrandLockup markSize={30} />
        </Link>
        <Button
          aria-controls="workspace-navigation"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? t("shell.closeNav") : t("shell.openNav")}
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
        aria-label={t("shell.navigation")}
        aria-modal={menuOpen ? true : undefined}
        className={`shell__rail ${menuOpen ? "shell__rail--open" : ""}`}
        ref={navigationRail}
        role={menuOpen ? "dialog" : undefined}
      >
        <div className="rail-brand-row">
          <Link aria-label={t("shell.brandHome")} className="brand" href="/">
            <BrandLockup descriptor={t("shell.brandLine")} />
          </Link>
          <Button
            aria-label={t("shell.closeNav")}
            className="rail-mobile-close"
            onClick={() => {
              setMenuOpen(false);
              requestAnimationFrame(() => menuButton.current?.focus());
            }}
            variant="quiet"
          >
            <X aria-hidden="true" size={20} />
          </Button>
        </div>
        <Button
          className="rail-collapse"
          aria-label={t(collapsed ? "shell.expand" : "shell.collapse")}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          variant="quiet"
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" size={17} />
          ) : (
            <PanelLeftClose aria-hidden="true" size={17} />
          )}
        </Button>
        <Button
          aria-label={t("shell.openCommands")}
          className="shortcut"
          onClick={openPalette}
          variant="quiet"
        >
          <Search aria-hidden="true" size={15} />
          <span>{t("shell.search")}</span>
          <kbd>Ctrl K</kbd>
        </Button>
        <nav aria-label={t("shell.modules")} className="nav">
          {groups.map((group) => (
            <div className="nav__group" key={group}>
              <p className="nav__group-label">{groupLabel(group)}</p>
              {navigation
                .filter((item) => item.group === group)
                .map(({ href, icon }) => {
                  const Icon = icons[icon];
                  const label = t(`shell.${navKey(href, icon)}`);
                  return (
                    <Link
                      aria-current={active === href ? "page" : undefined}
                      aria-label={label}
                      title={label}
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
            <span>{t("shell.workspace")}</span>
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
                  {membership.tenantName} · {t(`status.${membership.role}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="identity-summary">
            <span dir="ltr">{session.user.email}</span>
            <Button
              aria-label={t("shell.signOut")}
              disabled={sessionPending}
              onClick={() => void postSession("/api/auth/logout")}
              variant="quiet"
            >
              <LogOut aria-hidden="true" size={16} />
            </Button>
            <Button
              aria-label={
                themeMounted
                  ? t(resolvedTheme === "dark" ? "shell.light" : "shell.dark")
                  : t("shell.themeToggle")
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
          <LanguageControl />
          <Link className="text-link" href="/start">
            {t("common.guide")}
          </Link>
          {sessionError ? (
            <p className="form-error" role="alert">
              {sessionError}
            </p>
          ) : null}
        </div>
      </aside>
      {menuOpen ? (
        <button
          aria-label={t("shell.closeNav")}
          className="shell__scrim"
          onClick={() => {
            setMenuOpen(false);
            menuButton.current?.focus();
          }}
          type="button"
        />
      ) : null}
      <div
        aria-hidden={menuOpen ? true : undefined}
        className="shell__main"
        id="workspace-content"
        inert={menuOpen ? true : undefined}
        tabIndex={-1}
        key={session.tenant.tenantId}
      >
        {children}
      </div>
      <Dialog
        closeLabel={t("common.close")}
        description={t("shell.commandsHint")}
        onClose={() => setPaletteOpen(false)}
        open={paletteOpen}
        title={t("shell.commandsTitle")}
      >
        <Input
          data-dialog-initial-focus
          id="command-search"
          label={t("shell.destination")}
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
          placeholder={t("shell.searchHint")}
          value={query}
        />
        <div
          className="command-list"
          id="command-results"
          role="listbox"
          aria-label={t("shell.destinations")}
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
                {t(`shell.${navKey(item.href, item.icon)}`)}
                <small>{groupLabel(item.group)}</small>
              </span>
              <ArrowUpRight aria-hidden="true" size={16} />
            </button>
          ))}
        </div>
        {commands.length === 0 ? (
          <p role="status" className="muted">
            {t("shell.noResults")}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
