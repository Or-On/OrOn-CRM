"use client";

import { errorMessage } from "../../i18n/error-message";
import { useCapability } from "../access";
import { useTranslations } from "next-intl";

import { Plus, Search, UsersRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type { ContactSummary, ContactImportResult } from "@or-on/crm";
import { Badge, Button, EmptyState, Input, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";

export function ContactManager({
  contacts,
  query = "",
}: {
  readonly contacts: readonly ContactSummary[];
  readonly query?: string;
}) {
  const t = useTranslations();
  const canEdit = useCapability("crm:write");
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [importResult, setImportResult] = useState<ContactImportResult>();

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      await crmMutation("/api/crm/contacts", {
        name: data.get("name"),
        phone: data.get("phone"),
        email: data.get("email"),
        company: data.get("company"),
      });
      setCreating(false);
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught, t, "contacts.addFailed"));
    } finally {
      setPending(false);
    }
  }

  async function importCsv(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await crmMutation<ContactImportResult>(
        "/api/crm/contacts/import",
        { csv: data.get("csv") },
      );
      setImportResult(result);
      if (result.errors.length === 0) {
        form.reset();
        setImporting(false);
      }
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught, t, "contacts.importFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="feature-stack">
      {importResult ? (
        <div role="status" className="import-result">
          <p>
            {t("contacts.importResult", {
              created: importResult.created,
              skipped: importResult.skipped,
            })}
          </p>
          {importResult.errors.length ? (
            <ul>
              {importResult.errors.map((item) => (
                <li key={item.row}>
                  {t("contacts.importRow", {
                    row: item.row,
                    reason: errorMessage(item.reason, t, "validation.format"),
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="feature-toolbar">
        <form action="/contacts" className="feature-search" role="search">
          <Search aria-hidden="true" size={16} />
          <input
            aria-label={t("contacts.search")}
            name="q"
            defaultValue={query}
            placeholder={t("contacts.searchHint")}
          />
        </form>
        <div className="form-actions">
          <Button
            disabled={!canEdit || pending}
            onClick={() => setImporting((value) => !value)}
            variant="secondary"
          >
            {t("contacts.importCsv")}
          </Button>
          <Button
            disabled={!canEdit || pending}
            onClick={() => setCreating((value) => !value)}
          >
            <Plus aria-hidden="true" size={16} />
            {t("contacts.add")}
          </Button>
        </div>
      </div>

      <p className="public-note">
        {t("contacts.count", { count: contacts.length })}
        {contacts.length >= 100 ? " · " + t("contacts.limit") : ""}
      </p>
      {query ? (
        <Link className="text-link" href="/contacts">
          {t("contacts.searchClear")}
        </Link>
      ) : null}
      {error && !creating ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {importing ? (
        <Surface className="feature-form" level="raised">
          <form onSubmit={(event) => void importCsv(event)}>
            <fieldset className="form-fieldset" disabled={pending || !canEdit}>
              {!canEdit ? (
                <p className="public-note">{t("common.readOnly")}</p>
              ) : null}
              <label htmlFor="contacts-csv">{t("contacts.csvLabel")}</label>
              <textarea id="contacts-csv" name="csv" required rows={7} />
              <div className="form-actions">
                <Button disabled={pending || !canEdit} type="submit">
                  {t("contacts.importAction")}
                </Button>
                <Button
                  onClick={() => setImporting(false)}
                  type="button"
                  variant="quiet"
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </fieldset>
          </form>
        </Surface>
      ) : null}

      {creating ? (
        <Surface className="feature-form" level="raised">
          <form onSubmit={(event) => void submit(event)}>
            <fieldset className="form-fieldset" disabled={pending || !canEdit}>
              {!canEdit ? (
                <p className="public-note">{t("common.readOnly")}</p>
              ) : null}
              <div className="form-grid">
                <Input
                  id="contact-name"
                  label={t("common.name")}
                  name="name"
                  required
                />
                <Input
                  id="contact-phone"
                  label={t("contacts.phone")}
                  name="phone"
                  type="tel"
                  dir="ltr"
                  placeholder="+14155550123"
                  required
                />
                <Input
                  id="contact-email"
                  label={t("common.email")}
                  name="email"
                  type="email"
                />
                <Input
                  id="contact-company"
                  label={t("common.company")}
                  name="company"
                />
              </div>
              {error === undefined ? null : (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <div className="form-actions">
                <Button disabled={pending || !canEdit} type="submit">
                  {pending ? t("contacts.adding") : t("contacts.add")}
                </Button>
                <Button
                  onClick={() => setCreating(false)}
                  type="button"
                  variant="quiet"
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </fieldset>
          </form>
        </Surface>
      ) : null}

      {contacts.length === 0 ? (
        <EmptyState
          description={t("contacts.emptyHint")}
          title={t("contacts.empty")}
        />
      ) : (
        <div className="contact-grid">
          {contacts.map((contact) => {
            const primary = contact.identities.find(
              (identity) => identity.isPrimary,
            );
            return (
              <Surface className="contact-card" key={contact.id}>
                <div className="contact-card__heading">
                  <span className="contact-avatar" aria-hidden="true">
                    <UsersRound size={17} />
                  </span>
                  <div>
                    <h2>{contact.name}</h2>
                    <p>{contact.company ?? t("contacts.independent")}</p>
                  </div>
                  <Badge
                    label={
                      t.has(`status.${contact.lifecycleStatus}`)
                        ? t(`status.${contact.lifecycleStatus}`)
                        : t("common.unknown")
                    }
                    tone={
                      contact.lifecycleStatus === "blocked"
                        ? "critical"
                        : "positive"
                    }
                  />
                </div>
                <dl className="contact-card__details">
                  <div>
                    <dt>{t("contacts.channel")}</dt>
                    <dd>
                      <bdi dir="ltr">
                        {primary?.normalizedValue ?? t("common.notSet")}
                      </bdi>
                    </dd>
                  </div>
                  <div>
                    <dt>{t("common.email")}</dt>
                    <dd>
                      <bdi dir="ltr">{contact.email ?? t("common.notSet")}</bdi>
                    </dd>
                  </div>
                </dl>
                <div className="tag-row">
                  {contact.tags.map((tag) => (
                    <span key={tag.id} style={{ borderColor: tag.color }}>
                      {tag.name}
                    </span>
                  ))}
                </div>
                <Link className="text-link" href={`/contacts/${contact.id}`}>
                  {t("contacts.open")}
                </Link>
              </Surface>
            );
          })}
        </div>
      )}
    </div>
  );
}
