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
        {(
          message.openingMenu.buttons ?? [
            t("inbox.openingMenu.services"),
            t("inbox.openingMenu.support"),
          ]
        ).map((button, index) => (
          <li key={index}>{button}</li>
        ))}
      </ul>
      <p role="status">
        {t(`inbox.openingMenu.${message.openingMenu.outcome}`)}
      </p>
    </div>
  );
}
