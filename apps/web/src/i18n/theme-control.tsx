"use client";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";

export function ThemeControl() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const t = useTranslations("shell");
  useEffect(() => setMounted(true), []);
  return (
    <label className="theme-control">
      <span className="or-visually-hidden">{t("themeToggle")}</span>
      <select
        value={mounted ? theme : "dark"}
        disabled={!mounted}
        onChange={(event) => setTheme(event.target.value)}
      >
        <option value="dark">{t("themeDark")}</option>
        <option value="light">{t("themeLight")}</option>
        <option value="system">{t("themeSystem")}</option>
      </select>
    </label>
  );
}
