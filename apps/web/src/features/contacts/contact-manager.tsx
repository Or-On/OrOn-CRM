"use client";

import { Plus, Search, UsersRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type { ContactSummary } from "@or-on/crm";
import { Badge, Button, EmptyState, Input, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";

export function ContactManager({
  contacts,
}: {
  readonly contacts: readonly ContactSummary[];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

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
      setError(
        caught instanceof Error ? caught.message : "Unable to add contact",
      );
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
      await crmMutation("/api/crm/contacts/import", { csv: data.get("csv") });
      form.reset();
      setImporting(false);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to import contacts",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="feature-stack">
      <div className="feature-toolbar">
        <form action="/contacts" className="feature-search" role="search">
          <Search aria-hidden="true" size={16} />
          <input
            aria-label="Search contacts"
            name="q"
            placeholder="Search name, company, email or phone"
          />
        </form>
        <div className="form-actions">
          <Button
            onClick={() => setImporting((value) => !value)}
            variant="secondary"
          >
            Import CSV
          </Button>
          <Button onClick={() => setCreating((value) => !value)}>
            <Plus aria-hidden="true" size={16} /> Add contact
          </Button>
        </div>
      </div>

      {importing ? (
        <Surface className="feature-form" level="raised">
          <form onSubmit={(event) => void importCsv(event)}>
            <label htmlFor="contacts-csv">
              Paste CSV with name, phone, email, and company headers
            </label>
            <textarea id="contacts-csv" name="csv" required rows={7} />
            <div className="form-actions">
              <Button disabled={pending} type="submit">
                Import contacts
              </Button>
              <Button
                onClick={() => setImporting(false)}
                type="button"
                variant="quiet"
              >
                Cancel
              </Button>
            </div>
          </form>
        </Surface>
      ) : null}

      {creating ? (
        <Surface className="feature-form" level="raised">
          <form onSubmit={(event) => void submit(event)}>
            <div className="form-grid">
              <Input id="contact-name" label="Name" name="name" required />
              <Input
                id="contact-phone"
                label="WhatsApp number"
                name="phone"
                placeholder="+14155550123"
                required
              />
              <Input
                id="contact-email"
                label="Email"
                name="email"
                type="email"
              />
              <Input id="contact-company" label="Company" name="company" />
            </div>
            {error === undefined ? null : (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <Button disabled={pending} type="submit">
                {pending ? "Adding…" : "Add contact"}
              </Button>
              <Button
                onClick={() => setCreating(false)}
                type="button"
                variant="quiet"
              >
                Cancel
              </Button>
            </div>
          </form>
        </Surface>
      ) : null}

      {contacts.length === 0 ? (
        <EmptyState
          description="Add a fictional contact or inject a simulator message to begin."
          title="No contacts yet"
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
                    <p>{contact.company ?? "Independent contact"}</p>
                  </div>
                  <Badge
                    label={contact.lifecycleStatus}
                    tone={
                      contact.lifecycleStatus === "blocked"
                        ? "critical"
                        : "positive"
                    }
                  />
                </div>
                <dl className="contact-card__details">
                  <div>
                    <dt>Channel</dt>
                    <dd>{primary?.normalizedValue ?? "Not set"}</dd>
                  </div>
                  <div>
                    <dt>Email</dt>
                    <dd>{contact.email ?? "Not set"}</dd>
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
                  Open contact
                </Link>
              </Surface>
            );
          })}
        </div>
      )}
    </div>
  );
}
