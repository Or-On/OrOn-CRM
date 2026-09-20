"use client";

import type { ContactSummary, ServiceDirectory as Directory } from "@or-on/crm";
import {
  Button,
  EmptyState,
  InlineFeedback,
  Input,
  Select,
  Surface,
} from "@or-on/ui";
import { Building2, MapPin } from "lucide-react";
import { useLocale } from "next-intl";
import { useEffect, useState, type SyntheticEvent } from "react";
import { crmMutation, crmRead } from "../crm";

function optionalFormText(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function ServiceDirectory({
  contacts,
}: {
  readonly contacts: readonly ContactSummary[];
}) {
  const he = useLocale().startsWith("he");
  const [directory, setDirectory] = useState<Directory>();
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [feedback, setFeedback] = useState<{
    message: string;
    critical: boolean;
  }>();
  const [kind, setKind] = useState<"chain" | "store">("store");

  useEffect(() => {
    let cancelled = false;
    void crmRead<Directory>("/api/field-service/directory")
      .then((result) => {
        if (!cancelled) setDirectory(result);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setFeedback({
            critical: true,
            message:
              error instanceof Error
                ? error.message
                : he
                  ? "לא ניתן לטעון את הסניפים."
                  : "Could not load the directory.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [he, refresh]);

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    setPending(true);
    setFeedback(undefined);
    try {
      await crmMutation("/api/field-service/directory", {
        kind,
        name: form.get("name"),
        chainId: optionalFormText(form, "chainId"),
        contactId: optionalFormText(form, "contactId"),
        address: optionalFormText(form, "address"),
      });
      element.reset();
      setRefresh((value) => value + 1);
      setFeedback({
        critical: false,
        message: he
          ? "פרטי הרשת והסניף עודכנו."
          : "The directory has been updated.",
      });
    } catch (error) {
      setFeedback({
        critical: true,
        message:
          error instanceof Error
            ? error.message
            : he
              ? "השמירה נכשלה."
              : "Could not save the directory entry.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="service-directory"
      dir={he ? "rtl" : "ltr"}
      aria-labelledby="service-directory-heading"
    >
      <div className="field-service-toolbar">
        <div>
          <h2 id="service-directory-heading">
            {he ? "רשתות וסניפים" : "Chains & stores"}
          </h2>
          <p>
            {he
              ? "חיבור סניף לאיש קשר מאפשר לסוכן לזהות את החנות לפי מספר הטלפון."
              : "Link a store to its contact so the agent can identify the location from the caller's phone number."}
          </p>
        </div>
        <Button
          variant="quiet"
          disabled={pending}
          onClick={() => {
            setFeedback(undefined);
            setRefresh((value) => value + 1);
          }}
        >
          {he ? "רענון" : "Refresh"}
        </Button>
      </div>
      {feedback ? (
        <InlineFeedback
          description={feedback.message}
          tone={feedback.critical ? "critical" : "positive"}
        />
      ) : null}
      <div className="service-directory__layout">
        <Surface className="service-directory__form" level="raised">
          <form
            className="field-service-form"
            onSubmit={(event) => void save(event)}
          >
            <h3>{he ? "הוספה לספר הסניפים" : "Add to the directory"}</h3>
            <Select
              id="directory-kind"
              label={he ? "סוג רשומה" : "Entry type"}
              disabled={pending}
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as "chain" | "store")
              }
            >
              <option value="store">
                {he ? "חנות / סניף" : "Store / branch"}
              </option>
              <option value="chain">{he ? "רשת" : "Chain"}</option>
            </Select>
            <Input
              id="directory-name"
              label={he ? "שם" : "Name"}
              name="name"
              maxLength={200}
              required
              disabled={pending}
            />
            {kind === "store" ? (
              <>
                <Select
                  id="directory-chain"
                  label={he ? "רשת" : "Chain"}
                  name="chainId"
                  disabled={pending}
                >
                  <option value="">
                    {he ? "חנות עצמאית" : "Independent store"}
                  </option>
                  {directory?.chains.map((chain) => (
                    <option key={chain.id} value={chain.id}>
                      {chain.name}
                    </option>
                  ))}
                </Select>
                <Select
                  id="directory-contact"
                  label={he ? "איש קשר של הסניף" : "Store contact"}
                  name="contactId"
                  disabled={pending}
                >
                  <option value="">
                    {he ? "ללא איש קשר מקושר" : "No linked contact"}
                  </option>
                  {contacts.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.name}
                    </option>
                  ))}
                </Select>
                <Input
                  id="directory-address"
                  label={he ? "כתובת" : "Address"}
                  name="address"
                  maxLength={500}
                  disabled={pending}
                />
              </>
            ) : null}
            <Button type="submit" busy={pending} disabled={pending}>
              {he ? "שמירה" : "Save entry"}
            </Button>
          </form>
        </Surface>
        <div className="service-directory__stores" aria-live="polite">
          {!directory ? (
            <p role="status">{he ? "טוען סניפים…" : "Loading stores…"}</p>
          ) : directory.stores.length === 0 ? (
            <Surface level="raised">
              <EmptyState
                title={he ? "אין סניפים עדיין" : "No stores yet"}
                description={
                  he
                    ? "הוסיפו רשתות וסניפים כדי להתחיל לזהות את מיקום הלקוחות."
                    : "Add chains and stores to start identifying customer locations."
                }
              />
            </Surface>
          ) : (
            directory.stores.map((store) => (
              <Surface
                as="article"
                className="service-directory__store"
                level="raised"
                key={store.id}
              >
                <Building2 aria-hidden="true" size={20} />
                <div>
                  <small dir="auto">
                    {store.chainName ??
                      (he ? "חנות עצמאית" : "Independent store")}
                  </small>
                  <h3 dir="auto">{store.name}</h3>
                  <p dir="auto">
                    <MapPin aria-hidden="true" size={14} />
                    {store.address ??
                      (he ? "לא הוזנה כתובת" : "Address not supplied")}
                  </p>
                  <small>
                    {contacts.find((contact) => contact.id === store.contactId)
                      ?.name ??
                      (he ? "ללא איש קשר מקושר" : "No linked contact")}
                  </small>
                </div>
              </Surface>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
