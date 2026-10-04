"use client";
import type { Message } from "@or-on/crm";
import { useTranslations } from "next-intl";
export function OpeningMenuContent({ message }: { readonly message: Message }) {
  const t = useTranslations();
  if (!message.openingMenu) return null;
  return (
    <div className="template-message">
      <strong>{t("inbox.openingMenu.title")}</strong>
      <ul>
        <li>{t("inbox.openingMenu.services")}</li>
        <li>{t("inbox.openingMenu.support")}</li>
      </ul>
      <p role="status">
        {t(`inbox.openingMenu.${message.openingMenu.outcome}`)}
      </p>
    </div>
  );
}
