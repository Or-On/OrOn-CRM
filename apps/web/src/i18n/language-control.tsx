"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SelectInput } from "@or-on/ui";
import { changeLocale } from "./actions";
import { resolveLocale } from "./direction";

export function LanguageControl() {
  const locale = useLocale();
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  return (
    <div className="language-control">
      <label>
        <span className="or-visually-hidden">{t("language")}</span>
        <SelectInput
          aria-label={t("language")}
          title={t("language")}
          value={locale}
          disabled={pending}
          onChange={(event) => {
            const next = resolveLocale(event.target.value);
            startTransition(async () => {
              setFailed(false);
              try {
                if (/^\/(en|he)(\/|$)/u.test(pathname)) {
                  // Public locale routes share the root layout. A document navigation
                  // gets consistent SSR html direction and client dictionaries together.
                  // Workspace routes below refresh in place to retain unsent drafts.
                  window.location.assign(
                    pathname.replace(/^\/(en|he)/u, `/${next}`) +
                      window.location.search +
                      window.location.hash,
                  );
                } else {
                  await changeLocale(next);
                  router.refresh();
                }
              } catch {
                setFailed(true);
              }
            });
          }}
        >
          <option value="en" lang="en">
            English
          </option>
          <option value="he" lang="he">
            עברית
          </option>
        </SelectInput>
      </label>
      {failed ? <p role="alert">{t("languageFailed")}</p> : null}
    </div>
  );
}
