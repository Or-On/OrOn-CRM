"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type { ContactDetail } from "@or-on/crm";
import { Button, Input, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";
import { voiceMutation } from "../voice";

function fieldText(
  value: ContactDetail["customFields"][number]["value"],
): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

export function ContactDetailPanel({
  contact,
}: {
  readonly contact: ContactDetail;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function mutate(operation: () => Promise<unknown>) {
    setPending(true);
    setError(undefined);
    try {
      await operation();
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Contact update failed",
      );
    } finally {
      setPending(false);
    }
  }

  async function update(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutate(() =>
      crmMutation(
        `/api/crm/contacts/${contact.id}`,
        {
          name: data.get("name"),
          email: data.get("email"),
          company: data.get("company"),
        },
        { method: "PATCH" },
      ),
    );
  }

  async function addNote(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await mutate(() =>
      crmMutation(`/api/crm/contacts/${contact.id}/notes`, {
        body: data.get("body"),
      }),
    );
    form.reset();
  }

  const callableIdentity = contact.identities.find(
    (identity) =>
      (identity.channel === "phone" || identity.channel === "whatsapp") &&
      identity.normalizedValue !== null &&
      identity.validationStatus !== "invalid",
  );

  return (
    <div className="detail-grid">
      <Surface level="raised">
        <h2>Profile</h2>
        <form className="feature-form" onSubmit={(event) => void update(event)}>
          <Input
            defaultValue={contact.name}
            id="detail-name"
            label="Name"
            name="name"
            required
          />
          <Input
            defaultValue={contact.email ?? ""}
            id="detail-email"
            label="Email"
            name="email"
            type="email"
          />
          <Input
            defaultValue={contact.company ?? ""}
            id="detail-company"
            label="Company"
            name="company"
          />
          <Button disabled={pending} type="submit">
            Save profile
          </Button>
        </form>
        <div className="feature-form">
          <label htmlFor="voice-consent">Voice consent</label>
          <select
            disabled={pending}
            id="voice-consent"
            onChange={(event) =>
              void mutate(() =>
                crmMutation(
                  `/api/crm/contacts/${contact.id}`,
                  { voiceConsent: event.target.value },
                  { method: "PATCH" },
                ),
              )
            }
            value={contact.voiceConsent}
          >
            <option value="unknown">Unknown</option>
            <option value="granted">Granted</option>
            <option value="revoked">Revoked</option>
          </select>
          <Button
            disabled={
              pending ||
              contact.voiceConsent !== "granted" ||
              callableIdentity === undefined
            }
            onClick={() =>
              void mutate(() =>
                voiceMutation("/api/voice/simulated-calls", {
                  contactId: contact.id,
                  idempotencyKey: `contact:${contact.id}:${String(Date.now())}`,
                }),
              )
            }
            type="button"
            variant="secondary"
          >
            Start simulator call
          </Button>
          <small>Real carrier dialing remains disabled.</small>
        </div>
        <div className="detail-identities">
          <h3>Channel identities</h3>
          {contact.identities.map((identity) => (
            <p key={identity.id}>
              {identity.channel}:{" "}
              {identity.displayValue ?? identity.normalizedValue}
            </p>
          ))}
        </div>
      </Surface>

      <Surface>
        <h2>Notes</h2>
        <form className="note-form" onSubmit={(event) => void addNote(event)}>
          <label htmlFor="contact-note">Add an internal note</label>
          <textarea id="contact-note" name="body" required rows={4} />
          <Button disabled={pending} type="submit" variant="secondary">
            Add note
          </Button>
        </form>
        <div className="note-list">
          {contact.notes.length === 0 ? (
            <p>No notes yet.</p>
          ) : (
            contact.notes.map((note) => (
              <article key={note.id}>
                <p>{note.body}</p>
                <small>{new Date(note.createdAt).toLocaleString()}</small>
              </article>
            ))
          )}
        </div>
      </Surface>

      <Surface>
        <h2>Custom fields</h2>
        {contact.customFields.length === 0 ? (
          <p>No custom fields configured.</p>
        ) : (
          contact.customFields.map((field) => (
            <form
              className="custom-field-row"
              key={field.id}
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void mutate(() =>
                  crmMutation(
                    `/api/crm/contacts/${contact.id}/custom-fields/${field.id}`,
                    { value: data.get("value") },
                  ),
                );
              }}
            >
              <Input
                defaultValue={fieldText(field.value)}
                id={`field-${field.id}`}
                label={field.label}
                name="value"
              />
              <Button disabled={pending} type="submit" variant="quiet">
                Save
              </Button>
            </form>
          ))
        )}
      </Surface>
      {error === undefined ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
