"use client";

import {
  Activity,
  Bot,
  Boxes,
  ContactRound,
  MessagesSquare,
  MoonStar,
  PhoneCall,
  Sun,
  Workflow,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button, Dialog, Input } from "@or-on/ui";

const navigation = [
  { href: "/", label: "Foundation", icon: Boxes, available: true },
  {
    href: "/system/health",
    label: "System health",
    icon: Activity,
    available: true,
  },
  { href: "/inbox", label: "Inbox", icon: MessagesSquare, available: false },
  {
    href: "/contacts",
    label: "Contacts",
    icon: ContactRound,
    available: false,
  },
  { href: "/flows", label: "Flows", icon: Workflow, available: false },
  { href: "/voice", label: "Voice", icon: PhoneCall, available: false },
  { href: "/live", label: "Live agents", icon: Bot, available: false },
] as const;

export function AppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [themeMounted, setThemeMounted] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");

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

  return (
    <div className="shell">
      <aside aria-label="Primary navigation" className="shell__rail">
        <Link aria-label="Or-On Platform foundation" className="brand" href="/">
          <span aria-hidden="true" className="brand__mark">
            O
          </span>
          <span className="brand__copy">
            <span className="brand__name">Or-On Platform</span>
            <span className="brand__phase">Architecture foundation</span>
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
        description="Navigate implemented foundation surfaces. Planned modules remain disabled."
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
