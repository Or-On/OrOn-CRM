"use client";

import type { PublicSession } from "@or-on/auth";
import {
  Button,
  Dialog,
  IconButton,
  Input,
  PageTransition,
  Popover,
  SelectInput,
} from "@or-on/ui";
import {
  Activity,
  ArrowUpRight,
  Bot,
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Columns3,
  ContactRound,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Mail,
  Megaphone,
  Menu,
  MessagesSquare,
  MoonStar,
  PanelLeftClose,
  PanelLeftOpen,
  PhoneCall,
  LifeBuoy,
  ListChecks,
  LoaderCircle,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  ShieldCheck,
  Sun,
  UserCircle,
  UserPlus,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import { LanguageControl } from "../../i18n/language-control";
import { applyThemeTransition } from "../../i18n/theme-transition";
import { crmMutation } from "../crm";
import { IdentityImage } from "../identity";
import { NotificationCenter } from "./notification-center";

export { NotificationCenter } from "./notification-center";
import {
  activeDestination,
  contextualDestinations,
  findDestinations,
  navigation,
  destinationPermission,
  requiredFeatureForHref,
  type NavigationGroup,
  type NavigationIcon,
} from "./navigation";

const icons: Record<NavigationIcon, LucideIcon> = {
  overview: LayoutDashboard,
  inbox: MessagesSquare,
  email: Mail,
  calendar: CalendarDays,
  tickets: LifeBuoy,
  tasks: ListChecks,
  leads: UserPlus,
  contacts: ContactRound,
  pipeline: Columns3,
  campaigns: Megaphone,
  voice: PhoneCall,
  agents: Bot,
  finance: CreditCard,
  profile: UserCircle,
  users: Users,
  roles: ShieldCheck,
  settings: Settings,
  health: Activity,
  tenants: Building2,
  fieldService: Wrench,
  businessConfiguration: SlidersHorizontal,
};

const groups: readonly NavigationGroup[] = [
  "Workspace",
  "Operations",
  "Platform",
];

type Environment = "development" | "test" | "production";

const navigationPreferenceKey = "or-on.navigation-rail";

interface CommandEntry {
  readonly href: string;
  readonly icon: LucideIcon;
  readonly id: string;
  readonly label: string;
  readonly section: string;
}

function initials(email: string): string {
  return email.slice(0, 2).toLocaleUpperCase("en");
}

/** Account initials without a profile-image request. */
function InitialsAvatar({ label }: { readonly label: string }) {
  return (
    <span
      aria-hidden="true"
      className="identity-image identity-summary__avatar"
    >
      <span className="identity-image__fallback">{initials(label)}</span>
    </span>
  );
}

function NavigationPendingIndicator({ label }: { readonly label: string }) {
  const { pending } = useLinkStatus();
  return (
    <>
      <span
        aria-hidden="true"
        className="nav__pending"
        data-pending={pending ? "true" : "false"}
      >
        <LoaderCircle size={14} />
      </span>
      {pending ? (
        <span className="or-visually-hidden" role="status">
          {label}
        </span>
      ) : null}
    </>
  );
}

function InboxSearch() {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeQuery = searchParams.get("search") ?? "";
  const [query, setQuery] = useState(routeQuery);

  useEffect(() => {
    setQuery(routeQuery);
  }, [routeQuery]);

  function searchInbox(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = query.trim();
    const params = new URLSearchParams(searchParams.toString());
    if (term) params.set("search", term);
    else params.delete("search");
    setQuery(term);
    const search = params.toString();
    router.replace(search ? `/inbox?${search}` : "/inbox");
  }

  return (
    <form className="inbox-topbar-search" onSubmit={searchInbox}>
      <Search aria-hidden="true" size={15} />
      <label className="or-visually-hidden" htmlFor="inbox-shell-search">
        {t("inbox.search")}
      </label>
      <input
        id="inbox-shell-search"
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("inbox.searchHint")}
        type="search"
        value={query}
      />
    </form>
  );
}

export function AppShell({
  children,
  fieldServiceEnabled = false,
  enabledFeatures,
  session,
  tenantBranding,
}: {
  readonly children: ReactNode;
  readonly environment?: Environment;
  readonly fieldServiceEnabled?: boolean;
  readonly enabledFeatures?: readonly string[] | undefined;
  readonly session: PublicSession | undefined;
  readonly tenantBranding?: {
    readonly businessName: string;
    readonly accentToken:
      "blue" | "cyan" | "emerald" | "violet" | "amber" | "rose" | null;
  };
}) {
  const locale = useLocale();
  const t = useTranslations();
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [themeMounted, setThemeMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const menuButton = useRef<HTMLButtonElement>(null);
  const railButton = useRef<HTMLButtonElement>(null);
  const navigationRail = useRef<HTMLElement>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [sessionPending, setSessionPending] = useState(false);
  const [sessionError, setSessionError] = useState<string>();
  // Technicians work in a dedicated Field Service application: the shell keeps
  // only that module plus sign-out, language and theme. Server guards deny the
  // rest; this projection only avoids showing controls that cannot be used.
  const fieldServiceApp = session?.applicationScope === "field-service";
  const homeHref = fieldServiceApp ? "/field-service" : "/";
  const brandLabel = fieldServiceApp
    ? t("shell.fieldService")
    : t("shell.brandHome");
  const updateExpandedPreference = useCallback((next: boolean) => {
    setExpanded(next);
    try {
      localStorage.setItem(
        navigationPreferenceKey,
        next ? "expanded" : "collapsed",
      );
    } catch {
      // A blocked storage API must not prevent navigation from working.
    }
  }, []);

  const navKey = (icon: NavigationIcon) =>
    icon === "campaigns" ? "campaigns" : icon;
  const groupLabel = (group: NavigationGroup) =>
    t(
      `shell.${group === "Workspace" ? "workspace" : group === "Operations" ? "operations" : "platform"}`,
    );
  const active = activeDestination(pathname);
  const currentNavigation = navigation.find(({ href }) => href === active);
  const currentContext = contextualDestinations.find(
    ({ href }) => pathname === href || pathname.startsWith(`${href}/`),
  );
  const currentLabel = currentContext
    ? t(`shell.${currentContext.translationKey}`)
    : currentNavigation
      ? t(`shell.${navKey(currentNavigation.icon)}`)
      : t("shell.overview");
  const currentGroup = currentNavigation?.group ?? "Workspace";
  const featureEnabled = useCallback(
    (href: string) => {
      // Email has no approved tenant module yet and is not part of a package.
      if (href === "/email" && enabledFeatures !== undefined) return false;
      const required = requiredFeatureForHref(href);
      if (required === undefined) return true;
      if (enabledFeatures !== undefined)
        return enabledFeatures.includes(required);
      return required !== "field_service" || fieldServiceEnabled;
    },
    [enabledFeatures, fieldServiceEnabled],
  );
  const isInbox = pathname === "/inbox";
  // `parentHref` was previously ignored, so every contextual destination
  // appeared under Voice regardless of which module it belonged to. Filtering
  // on it is what lets a second module (Tickets, with internal Tasks beneath
  // it) have subroutes without leaking them into an unrelated rail.
  const contextParent = currentNavigation?.href ?? currentContext?.parentHref;
  const contextChildren = contextualDestinations.filter(
    (item) => item.parentHref === contextParent,
  );
  const hasContextNavigation = contextChildren.length > 0;
  const relatedDestinations =
    contextParent === undefined
      ? []
      : [
          {
            href: contextParent,
            label: t(
              `shell.${navKey(
                navigation.find(({ href }) => href === contextParent)?.icon ??
                  "overview",
              )}`,
            ),
          },
          ...contextChildren.map((item) => ({
            href: item.href,
            label: t(`shell.${item.translationKey}`),
          })),
        ];

  const commandEntries = useMemo<readonly CommandEntry[]>(() => {
    const destinationEntries = findDestinations(
      query,
      (item) =>
        `${t(`shell.${navKey(item.icon)}`)} ${groupLabel(item.group)} ${item.label}`,
    )
      .filter(
        (item) =>
          session?.permissions.includes(destinationPermission(item.href)) &&
          featureEnabled(item.href) &&
          (item.href !== "/tenants" || session.user.isSuperuser),
      )
      .map((item) => ({
        href: item.href,
        icon: icons[item.icon],
        id: `destination-${item.href}`,
        label: t(`shell.${navKey(item.icon)}`),
        section: groupLabel(item.group),
      }));

    const contextualEntries = contextualDestinations
      .filter((item) => {
        if (!session?.permissions.includes(destinationPermission(item.href)))
          return false;
        if (!featureEnabled(item.href)) return false;
        const term = query.trim().toLocaleLowerCase(locale);
        return `${t(`shell.${item.translationKey}`)} ${item.label}`
          .toLocaleLowerCase(locale)
          .includes(term);
      })
      .map((item) => ({
        href: item.href,
        icon: icons[item.icon],
        id: `context-${item.href}`,
        label: t(`shell.${item.translationKey}`),
        section: t("shell.contextual"),
      }));

    const supportedActions: CommandEntry[] = [
      ...(session?.permissions.includes("crm:write") === true
        ? [
            {
              href: "/contacts?create=1",
              icon: Plus,
              id: "action-create-contact",
              label: t("shell.createContact"),
              section: t("shell.actions"),
            },
          ]
        : []),
      ...(session?.permissions.includes("campaigns:manage") === true
        ? [
            {
              href: "/operations?create=campaign",
              icon: Megaphone,
              id: "action-start-campaign",
              label: t("shell.startCampaign"),
              section: t("shell.actions"),
            },
          ]
        : []),
      ...(session?.permissions.includes("flows:manage") === true
        ? [
            {
              href: "/orchestration?tab=agents",
              icon: Bot,
              id: "action-open-agents",
              label: t("shell.openAgents"),
              section: t("shell.actions"),
            },
            {
              href: "/orchestration?tab=flows",
              icon: Bot,
              id: "action-open-flows",
              label: t("shell.openFlows"),
              section: t("shell.actions"),
            },
          ]
        : []),
    ].filter(
      (item) =>
        featureEnabled(item.href.split("?")[0] ?? item.href) &&
        item.label
          .toLocaleLowerCase(locale)
          .includes(query.trim().toLocaleLowerCase(locale)),
    );

    const term = query.trim();
    const entitySearches: CommandEntry[] =
      term.length < 2 || !session?.permissions.includes("crm:read")
        ? []
        : [
            {
              href: `/contacts?q=${encodeURIComponent(term)}`,
              icon: ContactRound,
              id: "search-contacts",
              label: t("shell.searchContacts", { query: term }),
              section: t("shell.searchResults"),
            },
            {
              href: `/inbox?search=${encodeURIComponent(term)}`,
              icon: MessagesSquare,
              id: "search-conversations",
              label: t("shell.searchConversations", { query: term }),
              section: t("shell.searchResults"),
            },
          ].filter((item) =>
            featureEnabled(item.href.split("?")[0] ?? item.href),
          );

    return [
      ...supportedActions,
      ...entitySearches,
      ...destinationEntries,
      ...contextualEntries,
    ];
  }, [featureEnabled, locale, query, session?.permissions, t]);

  useEffect(() => setThemeMounted(true), []);
  useEffect(() => {
    try {
      setExpanded(
        localStorage.getItem(navigationPreferenceKey) !== "collapsed",
      );
    } catch {
      // Navigation density is a local preference, never authoritative state.
    }
  }, []);
  useEffect(() => {
    setMenuOpen(false);
    setAccountOpen(false);
    setCreateOpen(false);
  }, [pathname]);
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
    const focusable = () =>
      Array.from(
        rail.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          typeof element.checkVisibility !== "function" ||
          element.checkVisibility(),
      );
    const frame = requestAnimationFrame(() => focusable().at(0)?.focus());
    const trapFocus = (event: KeyboardEvent) => {
      const first = focusable().at(0);
      const last = focusable().at(-1);
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
        setMenuOpen(false);
        setQuery("");
        setCommandIndex(0);
        setPaletteOpen((value) => !value);
      }
      if (event.defaultPrevented || accountOpen || createOpen) return;
      if (event.key === "Escape" && menuOpen) {
        setMenuOpen(false);
        menuButton.current?.focus();
      } else if (event.key === "Escape" && expanded && !paletteOpen) {
        updateExpandedPreference(false);
        railButton.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    expanded,
    menuOpen,
    paletteOpen,
    accountOpen,
    createOpen,
    updateExpandedPreference,
  ]);

  function openPalette() {
    setMenuOpen(false);
    setAccountOpen(false);
    setCreateOpen(false);
    setQuery("");
    setCommandIndex(0);
    setPaletteOpen(true);
  }

  function closeMobileNavigation(restoreFocus = false) {
    setMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => menuButton.current?.focus());
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

  const isPublicAccessRoute =
    pathname === "/invite" || pathname.startsWith("/invite/");

  if (session === undefined || isPublicAccessRoute)
    return <div className="auth-layout">{children}</div>;

  const workspaceBrandName =
    tenantBranding?.businessName ?? session.tenant.tenantName;
  const workspaceBrandMark = (
    <IdentityImage
      className="workspace-brand-mark"
      contextKey={session.tenant.tenantId}
      fallback={workspaceBrandName.slice(0, 1).toLocaleUpperCase(locale)}
      source="/api/settings/logo"
    />
  );

  return (
    <div
      className={`shell ${expanded ? "shell--expanded" : ""} ${isInbox ? "shell--inbox" : ""}`}
      data-tenant-accent={tenantBranding?.accentToken ?? undefined}
    >
      <a className="skip-link" href="#workspace-content">
        {t("shell.skip")}
      </a>

      <header
        className="shell__mobile-header"
        inert={menuOpen || isInbox || undefined}
        aria-hidden={menuOpen || isInbox || undefined}
      >
        <Link aria-label={brandLabel} className="mobile-brand" href={homeHref}>
          {workspaceBrandMark}
          <span className="workspace-brand-name" dir="auto">
            {workspaceBrandName}
          </span>
        </Link>
        <strong className="mobile-context" dir="auto">
          {currentLabel}
        </strong>
        <IconButton
          className="mobile-command-trigger"
          label={t("shell.openCommands")}
          onClick={openPalette}
        >
          <Search aria-hidden="true" size={18} />
        </IconButton>
        <IconButton
          aria-controls="workspace-navigation"
          aria-expanded={menuOpen}
          label={menuOpen ? t("shell.closeNav") : t("shell.openNav")}
          onClick={() => setMenuOpen((value) => !value)}
          ref={menuButton}
        >
          {menuOpen ? (
            <X aria-hidden="true" size={20} />
          ) : (
            <Menu aria-hidden="true" size={20} />
          )}
        </IconButton>
      </header>

      <aside
        aria-hidden={isInbox || undefined}
        aria-label={t("shell.navigation")}
        aria-modal={menuOpen ? true : undefined}
        className={`shell__rail ${menuOpen ? "shell__rail--open" : ""}`}
        id="workspace-navigation"
        inert={isInbox || undefined}
        ref={navigationRail}
        role={menuOpen ? "dialog" : undefined}
      >
        <div className="rail-brand-row">
          <Link aria-label={brandLabel} className="brand" href={homeHref}>
            {workspaceBrandMark}
            <span className="brand__name" dir="auto">
              {workspaceBrandName}
            </span>
          </Link>
          <IconButton
            className="rail-mobile-close"
            label={t("shell.closeNav")}
            onClick={() => closeMobileNavigation(true)}
          >
            <X aria-hidden="true" size={20} />
          </IconButton>
        </div>

        {session.permissions.some((permission) =>
          ["crm:write", "campaigns:manage", "flows:manage"].includes(
            permission,
          ),
        ) ? (
          <div className="rail-quick-actions">
            <Popover
              role="menu"
              label={t("premiumShell.quickCreate")}
              open={createOpen}
              onOpenChange={setCreateOpen}
              triggerClassName="rail-quick-create"
              contentClassName="quick-create-menu"
              trigger={
                <>
                  <Plus aria-hidden="true" size={18} />
                  <span>{t("premiumShell.quickCreate")}</span>
                  <ChevronDown aria-hidden="true" size={14} />
                </>
              }
            >
              {({ close }) => (
                <>
                  <p className="eyebrow">{t("shell.actions")}</p>
                  {[
                    {
                      permission: "crm:write",
                      href: "/contacts?create=1",
                      label: t("shell.createContact"),
                      Icon: ContactRound,
                    },
                    {
                      permission: "campaigns:manage",
                      href: "/operations?create=campaign",
                      label: t("shell.startCampaign"),
                      Icon: Megaphone,
                    },
                    {
                      permission: "flows:manage",
                      href: "/orchestration?tab=agents",
                      label: t("shell.openAgents"),
                      Icon: Bot,
                    },
                  ]
                    .filter((item) =>
                      session.permissions.includes(item.permission),
                    )
                    .map(({ href, label, Icon }) => (
                      <Link
                        role="menuitem"
                        key={href}
                        href={href}
                        onClick={() => {
                          close();
                          closeMobileNavigation(false);
                        }}
                      >
                        <Icon aria-hidden="true" size={18} />
                        <span>{label}</span>
                        <ArrowUpRight aria-hidden="true" size={14} />
                      </Link>
                    ))}
                </>
              )}
            </Popover>
          </div>
        ) : null}

        <nav aria-label={t("shell.modules")} className="nav">
          {groups
            .filter((group) =>
              navigation.some(
                (item) =>
                  item.group === group &&
                  featureEnabled(item.href) &&
                  (item.href !== "/tenants" || session.user.isSuperuser) &&
                  session.permissions.includes(
                    destinationPermission(item.href),
                  ),
              ),
            )
            .map((group) => (
              <div className="nav__group" key={group}>
                <p className="nav__group-label">{groupLabel(group)}</p>
                {navigation
                  .filter(
                    (item) =>
                      item.group === group &&
                      featureEnabled(item.href) &&
                      (item.href !== "/tenants" || session.user.isSuperuser) &&
                      session.permissions.includes(
                        destinationPermission(item.href),
                      ),
                  )
                  .map(({ href, icon }) => {
                    const Icon = icons[icon];
                    const label = t(`shell.${navKey(icon)}`);
                    return (
                      <Link
                        aria-current={active === href ? "page" : undefined}
                        aria-label={label}
                        className={`nav__item ${active === href ? "nav__item--active" : ""}`}
                        href={href}
                        key={href}
                        onFocus={() => router.prefetch(href)}
                        onMouseEnter={() => router.prefetch(href)}
                        onPointerDown={() => router.prefetch(href)}
                        onClick={() => {
                          closeMobileNavigation(pathname === href && menuOpen);
                        }}
                        prefetch={
                          href === "/tickets" || href === "/calendar"
                            ? true
                            : false
                        }
                        title={!expanded ? label : undefined}
                      >
                        <span className="nav__icon">
                          <Icon
                            aria-hidden="true"
                            size={18}
                            strokeWidth={1.7}
                          />
                        </span>
                        <span className="nav__label">{label}</span>
                        <NavigationPendingIndicator
                          label={t("common.loading")}
                        />
                      </Link>
                    );
                  })}
              </div>
            ))}
        </nav>

        <div className="shell__rail-footer">
          {fieldServiceApp ? null : (
            <Link
              aria-label={t("common.help")}
              className="nav__item"
              href="/start"
              title={t("common.help")}
            >
              <span className="nav__icon">
                <CircleHelp aria-hidden="true" size={19} />
              </span>
              <span className="nav__label">{t("common.help")}</span>
            </Link>
          )}
          <Popover
            label={t("shell.account")}
            open={accountOpen}
            onOpenChange={setAccountOpen}
            triggerClassName="rail-account-trigger"
            contentClassName="account-menu__panel"
            trigger={
              <>
                {fieldServiceApp ? (
                  <InitialsAvatar
                    label={session.user.displayName ?? session.user.email}
                  />
                ) : (
                  <IdentityImage
                    className="identity-summary__avatar"
                    fallback={initials(
                      session.user.displayName ?? session.user.email,
                    )}
                    source="/api/account/avatar"
                  />
                )}
                <span className="rail-account__copy" dir="auto">
                  <strong>
                    {session.user.displayName ?? session.user.email}
                  </strong>
                  <small>
                    {session.user.isSuperuser
                      ? t("shell.platformAdmin")
                      : `${session.tenant.tenantName} · ${t(`status.${session.tenant.role}`)}`}
                  </small>
                </span>
                <ChevronDown aria-hidden="true" size={12} />
              </>
            }
          >
            {() => (
              <>
                <div className="identity-summary__copy" dir="auto">
                  <strong>
                    {session.user.displayName ?? session.user.email}
                  </strong>
                  <small>{session.user.email}</small>
                </div>
                <label
                  className={`tenant-switcher ${session.user.isSuperuser ? "tenant-switcher--platform-admin" : ""}`}
                  htmlFor="active-tenant"
                >
                  <IdentityImage
                    className="tenant-switcher__monogram"
                    contextKey={session.tenant.tenantId}
                    fallback={session.tenant.tenantName
                      .slice(0, 1)
                      .toLocaleUpperCase(locale)}
                    source="/api/settings/logo"
                  />
                  <span className="tenant-switcher__copy">
                    <span>
                      {t("shell.workspace")} ·{" "}
                      {session.user.isSuperuser
                        ? t("shell.platformAdmin")
                        : t(`status.${session.tenant.role}`)}
                    </span>
                    <SelectInput
                      dir="auto"
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
                        <option
                          key={membership.tenantId}
                          value={membership.tenantId}
                        >
                          {membership.tenantName}
                        </option>
                      ))}
                    </SelectInput>
                  </span>
                  <ChevronDown aria-hidden="true" size={14} />
                </label>
                {fieldServiceApp ? null : (
                  <Link
                    className="text-link"
                    href="/profile"
                    onClick={() => {
                      setAccountOpen(false);
                      closeMobileNavigation(false);
                    }}
                  >
                    <UserCircle aria-hidden="true" size={16} />
                    {t("shell.profile")}
                  </Link>
                )}
                <Button
                  disabled={sessionPending}
                  onClick={() => void postSession("/api/auth/logout")}
                  variant="quiet"
                >
                  <LogOut aria-hidden="true" size={16} />
                  {t("shell.signOut")}
                </Button>
                {sessionError ? (
                  <p className="form-error" role="alert">
                    {sessionError}
                  </p>
                ) : null}
              </>
            )}
          </Popover>
        </div>
      </aside>

      {menuOpen ? (
        <button
          aria-label={t("shell.closeNav")}
          className="shell__scrim"
          onClick={() => closeMobileNavigation(true)}
          type="button"
        />
      ) : null}

      <div
        aria-hidden={menuOpen ? true : undefined}
        className={`shell__main ${hasContextNavigation ? "shell__main--with-context" : ""} ${isInbox ? "shell__main--inbox" : ""}`}
        inert={menuOpen ? true : undefined}
        key={session.tenant.tenantId}
      >
        <header className="shell__topbar">
          <div
            className={`topbar-leading ${isInbox ? "inbox-topbar-leading" : ""}`}
          >
            {isInbox ? (
              <>
                <Link
                  aria-label={brandLabel}
                  className="inbox-topbar-brand"
                  href={homeHref}
                >
                  {workspaceBrandMark}
                  <span className="workspace-brand-name" dir="auto">
                    {workspaceBrandName}
                  </span>
                </Link>
                <Suspense>
                  <InboxSearch />
                </Suspense>
              </>
            ) : (
              <>
                <IconButton
                  aria-expanded={expanded}
                  className="rail-collapse"
                  label={t(expanded ? "shell.collapse" : "shell.expand")}
                  onClick={() => updateExpandedPreference(!expanded)}
                  ref={railButton}
                >
                  {expanded ? (
                    <PanelLeftClose aria-hidden="true" size={16} />
                  ) : (
                    <PanelLeftOpen aria-hidden="true" size={16} />
                  )}
                </IconButton>
                <span className="topbar-separator" aria-hidden="true" />
                <Button
                  aria-label={t("shell.openCommands")}
                  className="topbar-search"
                  onClick={openPalette}
                  variant="quiet"
                >
                  <Search aria-hidden="true" size={15} />
                  <span>{t("shell.search")}</span>
                  <kbd>Ctrl/⌘ K</kbd>
                </Button>
              </>
            )}
          </div>
          <div className="topbar-actions">
            {fieldServiceApp ? null : <NotificationCenter />}
            <LanguageControl />
            <IconButton
              className="topbar-square-action theme-cycle-button"
              disabled={!themeMounted}
              label={
                themeMounted
                  ? t(resolvedTheme === "dark" ? "shell.light" : "shell.dark")
                  : t("shell.themeToggle")
              }
              onClick={(event) =>
                applyThemeTransition({
                  currentResolvedTheme: resolvedTheme,
                  origin: event.currentTarget,
                  setTheme,
                  targetTheme: resolvedTheme === "dark" ? "light" : "dark",
                })
              }
            >
              {themeMounted && resolvedTheme === "dark" ? (
                <Sun aria-hidden="true" size={17} />
              ) : (
                <MoonStar aria-hidden="true" size={17} />
              )}
            </IconButton>
            {fieldServiceApp ? null : (
              <Link
                aria-label={t("shell.health")}
                className="topbar-icon-link"
                href="/system/health"
                title={t("shell.health")}
              >
                <Activity aria-hidden="true" size={17} />
              </Link>
            )}
          </div>
        </header>
        {hasContextNavigation ? (
          <div className="shell__context-strip">
            <div className="topbar-context" aria-label={t("shell.pageContext")}>
              <span>{groupLabel(currentGroup)}</span>
              <ChevronRight aria-hidden="true" size={13} />
              <strong>{currentLabel}</strong>
            </div>
            <nav
              className="context-navigation"
              aria-label={t("shell.contextNavigation")}
            >
              {relatedDestinations.map(({ href, label }) => (
                <Link
                  href={href}
                  key={href}
                  aria-current={pathname === href ? "page" : undefined}
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>
        ) : null}
        <div className="shell__workspace" id="workspace-content" tabIndex={-1}>
          <PageTransition transitionKey={pathname}>{children}</PageTransition>
        </div>
      </div>

      <Dialog
        closeLabel={t("common.close")}
        description={t("shell.commandsHint")}
        onClose={() => setPaletteOpen(false)}
        open={paletteOpen}
        title={t("shell.commandsTitle")}
      >
        <Input
          aria-activedescendant={
            commandEntries[commandIndex]
              ? `command-${String(commandIndex)}`
              : undefined
          }
          aria-autocomplete="list"
          aria-controls="command-results"
          aria-expanded="true"
          data-dialog-initial-focus
          id="command-search"
          label={t("shell.destination")}
          onChange={(event) => {
            setQuery(event.target.value);
            setCommandIndex(0);
          }}
          onKeyDown={(event) => {
            if (commandEntries.length === 0) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setCommandIndex(
                (index) =>
                  (index +
                    (event.key === "ArrowDown"
                      ? 1
                      : commandEntries.length - 1)) %
                  commandEntries.length,
              );
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const command = commandEntries[commandIndex];
              if (command) navigate(command.href);
            }
          }}
          placeholder={t("shell.searchHint")}
          role="combobox"
          value={query}
        />
        <div
          aria-label={t("shell.destinations")}
          className="command-list"
          id="command-results"
          role="listbox"
        >
          {commandEntries.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                aria-selected={index === commandIndex}
                className={`command-item ${index === commandIndex ? "command-item--active" : ""}`}
                id={`command-${String(index)}`}
                key={item.id}
                onClick={() => navigate(item.href)}
                onMouseMove={() => setCommandIndex(index)}
                role="option"
                type="button"
              >
                <span className="command-item__icon">
                  <Icon aria-hidden="true" size={17} />
                </span>
                <span>
                  {item.label}
                  <small>{item.section}</small>
                </span>
                <ArrowUpRight aria-hidden="true" size={16} />
              </button>
            );
          })}
        </div>
        {commandEntries.length === 0 ? (
          <p className="muted" role="status">
            {t("shell.noResults")}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
