"use client";

import { ClipboardList, FileText, ScanText } from "lucide-react";
import { useLocale } from "next-intl";
import Link from "next/link";

import styles from "./field-service-navigation.module.css";

export type FieldServiceSection = "overview" | "reports" | "ocr";

export const fieldServiceSectionDestinations = {
  overview: "/field-service",
  reports: "/field-service/reports",
  ocr: "/field-service/ocr",
} as const satisfies Readonly<Record<FieldServiceSection, string>>;

export function FieldServiceNavigation({
  active,
  destinations = fieldServiceSectionDestinations,
}: {
  readonly active: FieldServiceSection;
  readonly destinations?: Readonly<Record<FieldServiceSection, string>>;
}) {
  const he = useLocale().startsWith("he");
  const items = [
    {
      key: "overview" as const,
      label: he ? "סקירה" : "Overview",
      Icon: ClipboardList,
    },
    {
      key: "reports" as const,
      label: he ? "דוחות" : "Reports",
      Icon: FileText,
    },
    { key: "ocr" as const, label: "OCR", Icon: ScanText },
  ];

  return (
    <nav
      aria-label={he ? "ניווט שירות שטח" : "Field Service sections"}
      className={styles.navigation}
    >
      <ul className={styles.list}>
        {items.map(({ Icon, key, label }) => (
          <li key={key}>
            <Link
              aria-current={active === key ? "page" : undefined}
              className={styles.link}
              href={destinations[key]}
            >
              <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
              <span>{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
