"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { ContactSummary } from "@or-on/crm";
import { Badge, DataTable } from "@or-on/ui";

export function ContactResults({
  contacts,
}: {
  readonly contacts: readonly ContactSummary[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const identity = (contact: ContactSummary) =>
    contact.identities.find((item) => item.isPrimary) ?? contact.identities[0];
  const activity = (contact: ContactSummary) =>
    contact.lastActivityAt ? (
      <time dateTime={contact.lastActivityAt}>
        {date.format(new Date(contact.lastActivityAt))}
      </time>
    ) : (
      <span>{t("tenantPrimary.noInteraction")}</span>
    );
  const profile = (contact: ContactSummary) => (
    <div className="contact-table__identity">
      <span className="contact-avatar" aria-hidden="true">
        {contact.name.trim().slice(0, 1)}
      </span>
      <div>
        <Link
          className="contact-profile-link"
          aria-label={`${t("contacts.open")}: ${contact.name}`}
          href={`/contacts/${contact.id}`}
        >
          <bdi>{contact.name}</bdi>
        </Link>
        <span className="contact-table__tags">
          {contact.tags.map((tag) => (
            <span key={tag.id}>
              <bdi>{tag.name}</bdi>
            </span>
          ))}
        </span>
      </div>
    </div>
  );
  const status = (contact: ContactSummary) => (
    <Badge
      label={t(`status.${contact.lifecycleStatus}`)}
      tone={contact.lifecycleStatus === "blocked" ? "critical" : "neutral"}
    />
  );
  return (
    <>
      <div className="contact-desktop-results">
        <DataTable label={t("pages.contactsTitle")} minWidth="45rem">
          <thead>
            <tr>
              <th scope="col">{t("contacts.profile")}</th>
              <th scope="col">{t("contacts.identities")}</th>
              <th scope="col">{t("common.company")}</th>
              <th scope="col">{t("inbox.status")}</th>
              <th scope="col">{t("tenantPrimary.lastInteraction")}</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((contact) => (
              <tr key={contact.id}>
                <th scope="row">{profile(contact)}</th>
                <td>
                  <div className="contact-table__channel">
                    <bdi>
                      {identity(contact)?.displayValue ??
                        identity(contact)?.normalizedValue ??
                        t("common.notSet")}
                    </bdi>
                    {contact.email ? <bdi>{contact.email}</bdi> : null}
                  </div>
                </td>
                <td>
                  <bdi>{contact.company ?? t("contacts.independent")}</bdi>
                </td>
                <td>{status(contact)}</td>
                <td>{activity(contact)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
      <ul
        className="contact-mobile-results"
        aria-label={t("pages.contactsTitle")}
      >
        {contacts.map((contact) => (
          <li key={contact.id}>
            <div className="contact-mobile-heading">
              {profile(contact)}
              {status(contact)}
            </div>
            <div className="contact-mobile-meta">
              <bdi>
                {identity(contact)?.displayValue ??
                  identity(contact)?.normalizedValue ??
                  contact.email ??
                  t("common.notSet")}
              </bdi>
              {activity(contact)}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
