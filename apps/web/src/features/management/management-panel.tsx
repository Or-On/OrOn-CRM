"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type {
  ApiKeySummary,
  NotificationSummary,
  TeamMember,
  TenantSettings,
} from "@or-on/crm";
import { Badge, Button, EmptyState, Input, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";

export function ManagementPanel({
  members,
  notifications,
  settings,
  apiKeys,
}: {
  readonly members: readonly TeamMember[];
  readonly notifications: readonly NotificationSummary[];
  readonly settings: TenantSettings;
  readonly apiKeys: readonly ApiKeySummary[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [issuedToken, setIssuedToken] = useState<string>();

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(undefined);
    try {
      const data = new FormData(event.currentTarget);
      await crmMutation(
        "/api/settings",
        {
          displayName: data.get("displayName"),
          defaultCurrency: data.get("defaultCurrency"),
          locale: data.get("locale"),
          timezone: data.get("timezone"),
        },
        { method: "PATCH" },
      );
      setMessage("Workspace settings saved.");
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Settings update failed",
      );
    } finally {
      setPending(false);
    }
  }

  async function issueKey(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const data = new FormData(event.currentTarget);
      const result = await crmMutation<{ token: string }>(
        "/api/settings/api-keys",
        {
          name: data.get("name"),
          scopes: ["crm:read", "crm:write"],
        },
      );
      setIssuedToken(result.token);
      event.currentTarget.reset();
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="operations-grid">
      <Surface level="raised">
        <h2>Workspace settings</h2>
        <form className="feature-form" onSubmit={(event) => void save(event)}>
          <Input
            defaultValue={settings.displayName ?? ""}
            id="display-name"
            label="Display name"
            name="displayName"
          />
          <Input
            defaultValue={settings.defaultCurrency}
            id="currency"
            label="Currency"
            maxLength={3}
            name="defaultCurrency"
            required
          />
          <Input
            defaultValue={settings.locale}
            id="locale"
            label="Locale"
            name="locale"
            required
          />
          <Input
            defaultValue={settings.timezone}
            id="timezone"
            label="Timezone"
            name="timezone"
            required
          />
          <Button disabled={pending} type="submit">
            Save settings
          </Button>
          {message === undefined ? null : <p aria-live="polite">{message}</p>}
        </form>
      </Surface>
      <Surface>
        <h2>Team</h2>
        <div className="operation-list">
          {members.map((member) => (
            <article key={member.userId}>
              <strong>{member.email}</strong>
              <Badge
                label={member.role}
                tone={member.role === "owner" ? "positive" : "neutral"}
              />
            </article>
          ))}
        </div>
        <p>
          Membership changes remain owner/admin controlled through the canonical
          identity boundary.
        </p>
      </Surface>
      <Surface>
        <h2>Notifications</h2>
        {notifications.length === 0 ? (
          <EmptyState
            title="No notifications"
            description="Operational alerts will appear here."
          />
        ) : (
          <div className="operation-list">
            {notifications.map((notification) => (
              <article key={notification.id}>
                <div>
                  <strong>{notification.title}</strong>
                  <p>{notification.body}</p>
                </div>
                <Badge
                  label={notification.read ? "read" : "unread"}
                  tone={notification.read ? "neutral" : "info"}
                />
              </article>
            ))}
          </div>
        )}
      </Surface>
      <Surface>
        <h2>WhatsApp provider safety</h2>
        <Badge label="Simulator only" tone="positive" />
        <p>
          Real WhatsApp delivery remains disabled. No access token or app secret
          is shown in the browser.
        </p>
      </Surface>
      <Surface>
        <h2>Scoped API keys</h2>
        <form
          className="feature-form"
          onSubmit={(event) => void issueKey(event)}
        >
          <Input id="api-key-name" label="Key name" name="name" required />
          <Button disabled={pending} type="submit" variant="secondary">
            Issue CRM key
          </Button>
        </form>
        {issuedToken === undefined ? null : (
          <p role="status">
            <strong>Copy once:</strong> <code>{issuedToken}</code>
          </p>
        )}
        <div className="operation-list">
          {apiKeys.map((key) => (
            <article key={key.id}>
              <div>
                <strong>{key.name}</strong>
                <p>
                  {key.prefix}… · {key.scopes.join(", ")}
                </p>
              </div>
              <Badge
                label={key.status}
                tone={key.status === "active" ? "positive" : "neutral"}
              />
            </article>
          ))}
        </div>
      </Surface>
    </div>
  );
}
