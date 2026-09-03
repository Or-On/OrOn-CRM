"use client";

import { errorMessage } from "../../i18n/error-message";
import { useTranslations } from "next-intl";

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
  realWhatsAppEnabled = false,
  canManage = false,
}: {
  readonly members: readonly TeamMember[];
  readonly notifications: readonly NotificationSummary[];
  readonly settings: TenantSettings;
  readonly apiKeys: readonly ApiKeySummary[];
  readonly realWhatsAppEnabled?: boolean;
  readonly canManage?: boolean;
}) {
  const t = useTranslations();
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
      setMessage(t("management.saved"));
      router.refresh();
    } catch (error) {
      setMessage(errorMessage(error, t, "management.failed"));
    } finally {
      setPending(false);
    }
  }

  async function issueKey(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
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
      setMessage(undefined);
      setIssuedToken(result.token);
      form.reset();
      router.refresh();
    } catch {
      setMessage(t("management.failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="operations-grid">
      <Surface level="raised">
        <h2>{t("management.title")}</h2>
        <form className="feature-form" onSubmit={(event) => void save(event)}>
          <fieldset disabled={pending || !canManage} className="form-fieldset">
            <Input
              defaultValue={settings.displayName ?? ""}
              id="display-name"
              label={t("management.displayName")}
              name="displayName"
            />
            <Input
              defaultValue={settings.defaultCurrency}
              id="currency"
              label={t("management.currency")}
              maxLength={3}
              name="defaultCurrency"
              required
            />
            <Input
              defaultValue={settings.locale}
              id="locale"
              label={t("management.locale")}
              name="locale"
              required
            />
            <Input
              defaultValue={settings.timezone}
              id="timezone"
              label={t("management.timezone")}
              name="timezone"
              required
            />
            <Button disabled={pending} type="submit">
              {t("management.save")}
            </Button>
            {message === undefined ? null : <p aria-live="polite">{message}</p>}
          </fieldset>
          {!canManage ? (
            <p className="public-note">{t("management.noPermission")}</p>
          ) : null}
        </form>
      </Surface>
      <Surface>
        <h2>{t("management.team")}</h2>
        <div className="operation-list">
          {members.map((member) => (
            <article key={member.userId}>
              <strong>{member.email}</strong>
              <Badge
                label={
                  t.has(`status.${member.role}`)
                    ? t(`status.${member.role}`)
                    : t("common.unknown")
                }
                tone={member.role === "owner" ? "positive" : "neutral"}
              />
            </article>
          ))}
        </div>
        <p>{t("management.teamHint")}</p>
      </Surface>
      <Surface>
        <h2>{t("management.notifications")}</h2>
        {notifications.length === 0 ? (
          <EmptyState
            title={t("management.empty")}
            description={t("management.emptyHint")}
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
                  label={t(notification.read ? "status.read" : "status.unread")}
                  tone={notification.read ? "neutral" : "info"}
                />
              </article>
            ))}
          </div>
        )}
      </Surface>
      <Surface>
        <h2>{t("management.safety")}</h2>
        <Badge
          label={t(
            realWhatsAppEnabled
              ? "management.realEnabled"
              : "management.simulator",
          )}
          tone={realWhatsAppEnabled ? "warning" : "info"}
        />
        <p>{t("management.safetyHint")}</p>
      </Surface>
      <Surface>
        <h2>{t("management.keys")}</h2>
        <form
          className="feature-form"
          onSubmit={(event) => void issueKey(event)}
        >
          <Input
            disabled={!canManage || pending}
            id="api-key-name"
            label={t("management.keyName")}
            name="name"
            required
          />
          <Button
            disabled={pending || !canManage}
            type="submit"
            variant="secondary"
          >
            {t("management.issue")}
          </Button>
        </form>
        {issuedToken === undefined ? null : (
          <p role="status">
            <strong>{t("management.copyOnce")}</strong>{" "}
            <code>{issuedToken}</code>
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
                label={
                  t.has(`status.${key.status}`)
                    ? t(`status.${key.status}`)
                    : t("common.unknown")
                }
                tone={key.status === "active" ? "positive" : "neutral"}
              />
            </article>
          ))}
        </div>
      </Surface>
    </div>
  );
}
