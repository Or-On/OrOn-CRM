"use client";

import { errorMessage } from "../../i18n/error-message";
import { useCapability } from "../access";
import { useLocale, useTranslations } from "next-intl";

import { Plus, Search, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type SyntheticEvent } from "react";

import type {
  ContactImportResult,
  ContactCursor,
  ContactSummary,
  CustomerClassification,
} from "@or-on/crm";
import {
  Button,
  Dialog,
  EmptyState,
  Input,
  Select,
  Surface,
  Textarea,
} from "@or-on/ui";

import { crmMutation, crmRead } from "../crm";
import { ContactResults } from "./contact-results";

type ContactPanel = "create" | "import";
type ContactChannel = ContactSummary["identities"][number]["channel"];
type LifecycleStatus = ContactSummary["lifecycleStatus"];

const lifecycleFilters = ["active", "blocked"] as const;
const channelFilters = [
  "whatsapp",
  "phone",
  "email",
  "sip",
  "external",
] as const satisfies readonly ContactChannel[];

function contactSearchText(contact: ContactSummary): string {
  return [
    contact.name,
    contact.company,
    contact.email,
    ...contact.identities.flatMap((identity) => [
      identity.normalizedValue,
      identity.displayValue,
      identity.channel,
    ]),
    ...contact.tags.map((tag) => tag.name),
    ...(contact.classifications ?? []).map(
      (classification) => classification.name,
    ),
  ]
    .filter((value): value is string => value !== null)
    .join(" ")
    .toLocaleLowerCase();
}

export function ContactManager({
  contacts: initialContacts,
  classifications = [],
  query = "",
  initialPanel,
  nextCursor: initialNextCursor = null,
}: {
  readonly contacts: readonly ContactSummary[];
  readonly classifications?: readonly CustomerClassification[];
  readonly query?: string;
  readonly initialPanel?: ContactPanel;
  readonly nextCursor?: ContactCursor | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const canEdit = useCapability("crm:write");
  const router = useRouter();
  const [panel, setPanel] = useState<ContactPanel | undefined>(initialPanel);
  const [pending, setPending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [contacts, setContacts] =
    useState<readonly ContactSummary[]>(initialContacts);
  const [nextCursor, setNextCursor] = useState<ContactCursor | null>(
    initialNextCursor,
  );
  const [error, setError] = useState<string>();
  const [importResult, setImportResult] = useState<ContactImportResult>();
  const [localQuery, setLocalQuery] = useState(query);
  const [lifecycle, setLifecycle] = useState<LifecycleStatus | "all">("all");
  const [sort, setSort] = useState("recent");
  const [tag, setTag] = useState("all");
  const [resultPage, setResultPage] = useState(0);
  const [channel, setChannel] = useState<ContactChannel | "all">("all");
  const [classification, setClassification] = useState("all");

  useEffect(() => setLocalQuery(query), [query]);
  useEffect(() => setPanel(initialPanel), [initialPanel]);
  useEffect(() => {
    setContacts(initialContacts);
    setNextCursor(initialNextCursor);
    setResultPage(0);
  }, [initialContacts, initialNextCursor]);

  async function loadMoreContacts() {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const parameters = new URLSearchParams({
        cursorAt: nextCursor.sortAt,
        cursorId: nextCursor.id,
        limit: "50",
      });
      if (query.trim() !== "") parameters.set("q", query.trim());
      const page = await crmRead<{
        readonly contacts: readonly ContactSummary[];
        readonly nextCursor: ContactCursor | null;
      }>(`/api/crm/contacts?${parameters.toString()}`);
      setContacts((current) => {
        const merged = new Map(current.map((contact) => [contact.id, contact]));
        for (const contact of page.contacts) merged.set(contact.id, contact);
        return [...merged.values()];
      });
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError(errorMessage(reason, t, "errors.unavailable"));
    } finally {
      setLoadingMore(false);
    }
  }

  const visibleContacts = useMemo(() => {
    const search = localQuery.trim().toLocaleLowerCase();
    const matches = contacts.filter(
      (contact) =>
        (search.length === 0 || contactSearchText(contact).includes(search)) &&
        (lifecycle === "all" || contact.lifecycleStatus === lifecycle) &&
        (tag === "all" || contact.tags.some((item) => item.id === tag)) &&
        (classification === "all" ||
          (contact.classifications ?? []).some(
            (item) => item.id === classification,
          )) &&
        (channel === "all" ||
          contact.identities.some((identity) => identity.channel === channel)),
    );
    return matches.sort((a, b) =>
      sort === "recent"
        ? new Date(b.lastActivityAt ?? b.createdAt).getTime() -
            new Date(a.lastActivityAt ?? a.createdAt).getTime() ||
          a.id.localeCompare(b.id)
        : (sort === "nameAsc" ? 1 : -1) *
            a.name.localeCompare(b.name, locale) || a.id.localeCompare(b.id),
    );
  }, [
    channel,
    classification,
    contacts,
    lifecycle,
    localQuery,
    locale,
    sort,
    tag,
  ]);
  const availableTags = [
    ...new Map(
      contacts.flatMap((contact) =>
        contact.tags.map((item) => [item.id, item] as const),
      ),
    ).values(),
  ];
  const pageSize = 25;
  const currentPage = Math.min(
    resultPage,
    Math.max(0, Math.ceil(visibleContacts.length / pageSize) - 1),
  );
  const pageContacts = visibleContacts.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const availableChannels = channelFilters.filter((candidate) =>
    contacts.some((contact) =>
      contact.identities.some((identity) => identity.channel === candidate),
    ),
  );

  function channelLabel(value: ContactChannel): string {
    if (t.has(`status.${value}`)) return t(`status.${value}`);
    if (value === "sip") return "SIP";
    return t("common.unknown");
  }

  function togglePanel(nextPanel: ContactPanel) {
    setPanel((current) => (current === nextPanel ? undefined : nextPanel));
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await crmMutation("/api/crm/contacts", {
        name: data.get("name"),
        phone: data.get("phone"),
        email: data.get("email"),
        company: data.get("company"),
      });
      form.reset();
      setPanel(undefined);
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
        setPanel(undefined);
      }
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught, t, "contacts.importFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="feature-stack contacts-workspace">
      <header className="contacts-resource-header">
        <div>
          <h2 className="or-visually-hidden">{t("contacts.directory")}</h2>
          <p>{t("contacts.count", { count: contacts.length })}</p>
        </div>
        <div className="contacts-index-actions">
          <Button
            aria-controls="contacts-import-panel"
            aria-expanded={panel === "import"}
            disabled={!canEdit || pending}
            onClick={() => togglePanel("import")}
            size="small"
            variant="secondary"
          >
            <Upload aria-hidden="true" size={15} />
            {t("contacts.importCsv")}
          </Button>
          <Button
            aria-controls="contacts-create-panel"
            aria-expanded={panel === "create"}
            disabled={!canEdit || pending}
            onClick={() => togglePanel("create")}
            size="small"
          >
            <Plus aria-hidden="true" size={15} />
            {t("contacts.add")}
          </Button>
        </div>
      </header>
      {importResult ? (
        <div role="status" className="import-result contacts-import-result">
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

      <div className="contacts-index-toolbar">
        <form
          action="/contacts"
          className="feature-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            router.push(`/contacts?q=${encodeURIComponent(localQuery.trim())}`);
          }}
        >
          <Search aria-hidden="true" size={16} />
          <input
            aria-label={t("contacts.search")}
            name="q"
            onChange={(event) => {
              setLocalQuery(event.target.value);
              setResultPage(0);
            }}
            placeholder={t("contacts.searchHint")}
            type="search"
            value={localQuery}
          />
          <Button type="submit" size="small" variant="secondary">
            {t("tenantPrimary.searchDirectory")}
          </Button>
          {localQuery ? (
            query ? (
              <Link className="text-link" href="/contacts">
                {t("contacts.searchClear")}
              </Link>
            ) : (
              <Button
                className="contacts-search-clear"
                onClick={() => setLocalQuery("")}
                size="small"
                variant="quiet"
              >
                {t("contacts.searchClear")}
              </Button>
            )
          ) : null}
        </form>

        <div className="contacts-index-filters">
          <Select
            id="contacts-status-filter"
            label={t("inbox.status")}
            onChange={(event) => {
              setLifecycle(event.target.value as LifecycleStatus | "all");
              setResultPage(0);
            }}
            value={lifecycle}
          >
            <option value="all">{t("contacts.allStatuses")}</option>
            {lifecycleFilters.map((value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </Select>
          <Select
            id="contacts-channel-filter"
            label={t("contacts.channel")}
            onChange={(event) => {
              setChannel(event.target.value as ContactChannel | "all");
              setResultPage(0);
            }}
            value={channel}
          >
            <option value="all">{t("contacts.allChannels")}</option>
            {availableChannels.map((value) => (
              <option key={value} value={value}>
                {channelLabel(value)}
              </option>
            ))}
          </Select>
          {availableTags.length ? (
            <Select
              id="contacts-tag-filter"
              label={t("tenantPrimary.tag")}
              value={tag}
              onChange={(event) => {
                setTag(event.target.value);
                setResultPage(0);
              }}
            >
              <option value="all">{t("tenantPrimary.allTags")}</option>
              {availableTags.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          ) : null}
          {classifications.length ? (
            <Select
              id="contacts-classification-filter"
              label={t("contacts.classification")}
              value={classification}
              onChange={(event) => {
                setClassification(event.target.value);
                setResultPage(0);
              }}
            >
              <option value="all">{t("contacts.allClassifications")}</option>
              {classifications.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Select
            id="contacts-sort"
            label={t("tenantPrimary.sort")}
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              setResultPage(0);
            }}
          >
            {["recent", "nameAsc", "nameDesc"].map((value) => (
              <option key={value} value={value}>
                {t(`tenantPrimary.${value}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="contacts-index-meta" aria-live="polite">
        <p>{t("tenantPrimary.resultsScope", { count: contacts.length })}</p>
      </div>

      {error && panel === undefined ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="contacts-body">
        <Dialog
          className="contacts-editor"
          closeLabel={t("common.close")}
          open={panel !== undefined}
          onClose={() => setPanel(undefined)}
          title={t(panel === "import" ? "contacts.importCsv" : "contacts.add")}
        >
          <Surface
            className="feature-form contacts-command-panel"
            id="contacts-import-panel"
            level="raised"
            hidden={panel !== "import"}
          >
            <form onSubmit={(event) => void importCsv(event)}>
              <fieldset
                className="form-fieldset"
                disabled={pending || !canEdit}
              >
                {!canEdit ? (
                  <p className="public-note">{t("common.readOnly")}</p>
                ) : null}
                <Textarea
                  data-dialog-initial-focus={
                    panel === "import" ? "" : undefined
                  }
                  id="contacts-csv"
                  label={t("contacts.csvLabel")}
                  name="csv"
                  required
                  rows={7}
                />
                {error === undefined ? null : (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="form-actions">
                  <Button busy={pending} disabled={!canEdit} type="submit">
                    {t("contacts.importAction")}
                  </Button>
                  <Button
                    onClick={() => setPanel(undefined)}
                    type="button"
                    variant="quiet"
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </fieldset>
            </form>
          </Surface>
          <Surface
            className="feature-form contacts-command-panel"
            id="contacts-create-panel"
            level="raised"
            hidden={panel !== "create"}
          >
            <p>{t("contacts.profileHint")}</p>
            <form onSubmit={(event) => void submit(event)}>
              <fieldset
                className="form-fieldset"
                disabled={pending || !canEdit}
              >
                {!canEdit ? (
                  <p className="public-note">{t("common.readOnly")}</p>
                ) : null}
                <div className="form-grid">
                  <Input
                    data-dialog-initial-focus={
                      panel === "create" ? "" : undefined
                    }
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
                  <Button busy={pending} disabled={!canEdit} type="submit">
                    {pending ? t("contacts.adding") : t("contacts.add")}
                  </Button>
                  <Button
                    onClick={() => setPanel(undefined)}
                    type="button"
                    variant="quiet"
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </fieldset>
            </form>
          </Surface>
        </Dialog>
        <div className="contacts-results">
          {contacts.length === 0 ? (
            <EmptyState
              description={t("contacts.emptyHint")}
              title={t("contacts.empty")}
            />
          ) : visibleContacts.length === 0 ? (
            <EmptyState
              description={t("inbox.searchHelp")}
              title={t("inbox.noMatches")}
            />
          ) : (
            <ContactResults contacts={pageContacts} />
          )}
        </div>
        {visibleContacts.length > pageSize || nextCursor !== null ? (
          <nav
            className="contacts-pagination"
            aria-label={t("tenantPrimary.page", {
              start: currentPage * pageSize + 1,
              end: Math.min(
                (currentPage + 1) * pageSize,
                visibleContacts.length,
              ),
              count: visibleContacts.length,
            })}
          >
            <span>
              {t("tenantPrimary.page", {
                start: currentPage * pageSize + 1,
                end: Math.min(
                  (currentPage + 1) * pageSize,
                  visibleContacts.length,
                ),
                count: visibleContacts.length,
              })}
            </span>
            <Button
              disabled={currentPage === 0}
              onClick={() => setResultPage(currentPage - 1)}
              variant="secondary"
            >
              {t("tenantPrimary.previous")}
            </Button>
            <Button
              disabled={(currentPage + 1) * pageSize >= visibleContacts.length}
              onClick={() => setResultPage(currentPage + 1)}
              variant="secondary"
            >
              {t("tenantPrimary.next")}
            </Button>
            {nextCursor === null ? null : (
              <Button
                busy={loadingMore}
                disabled={loadingMore}
                onClick={() => void loadMoreContacts()}
                variant="secondary"
              >
                {t("tenantPrimary.loadMore")}
              </Button>
            )}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
