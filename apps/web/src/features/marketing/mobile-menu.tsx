"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

export function MobileMarketingMenu() {
  const t = useTranslations("marketing");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  const close = () => setOpen(false);
  const closeTo = (targetId: string) => {
    setOpen(false);
    requestAnimationFrame(() => {
      document.getElementById(targetId)?.focus({ preventScroll: true });
    });
  };
  return (
    <div className="public-menu" ref={root}>
      <button
        aria-controls="public-mobile-navigation"
        aria-expanded={open}
        aria-label={t(open ? "closeMenu" : "menu")}
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
        type="button"
      >
        {open ? (
          <X aria-hidden="true" size={18} />
        ) : (
          <Menu aria-hidden="true" size={18} />
        )}
        <span>{t(open ? "closeMenu" : "menu")}</span>
      </button>
      <nav
        aria-label={t("mobileNavigation")}
        className="public-menu__links"
        hidden={!open}
        id="public-mobile-navigation"
      >
        <a href="#workflow" onClick={() => closeTo("workflow")}>
          {t("navWorkflow")}
        </a>
        <a href="#security" onClick={() => closeTo("security")}>
          {t("navSecurity")}
        </a>
        <a href="#questions" onClick={() => closeTo("questions")}>
          {t("navFaq")}
        </a>
        <Link href="/login" onClick={close}>
          {t("signIn")}
        </Link>
      </nav>
    </div>
  );
}
