"use client";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { SelectInput } from "@or-on/ui";

import { applyThemeTransition } from "./theme-transition";

export function ThemeControl() {
  const { resolvedTheme, setTheme, systemTheme, theme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const t = useTranslations("shell");
  useEffect(() => setMounted(true), []);
  return (
    <label className="theme-control">
      <span className="or-visually-hidden">{t("themeToggle")}</span>
      <SelectInput
        disabled={!mounted}
        onChange={(event) =>
          applyThemeTransition({
            currentResolvedTheme: resolvedTheme,
            origin: event.currentTarget,
            setTheme,
            systemTheme,
            targetTheme: event.currentTarget.value,
          })
        }
        value={mounted ? (theme ?? "system") : "dark"}
      >
        <option value="dark">{t("themeDark")}</option>
        <option value="light">{t("themeLight")}</option>
        <option value="system">{t("themeSystem")}</option>
      </SelectInput>
    </label>
  );
}
