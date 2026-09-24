"use client";

import type {
  ApiKeySummary,
  FieldServiceFeatureState,
  NotificationSummary,
  TeamMember,
  TenantInvitationSummary,
  TenantSettings,
} from "@or-on/crm";
import {
  Badge,
  Button,
  ConfirmDialog,
  Combobox,
  Dialog,
  EmptyState,
  Input,
  InlineFeedback,
  SectionHeader,
  Select,
  SelectInput,
  StatusIndicator,
  Surface,
  Tabs,
  Textarea,
} from "@or-on/ui";
import {
  BellRing,
  Building2,
  KeyRound,
  LockKeyhole,
  Palette,
  ShieldCheck,
  ArrowUpRight,
  Trash2,
  UserPlus,
  UserRound,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useTimeZone, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type SyntheticEvent } from "react";

import { errorMessage } from "../../i18n/error-message";
import { LanguageControl } from "../../i18n/language-control";
import { ThemeControl } from "../../i18n/theme-control";
import { useCapability } from "../access";
import { crmMutation } from "../crm";
import { IdentityImage, IdentityImageEditor } from "../identity";
import { FieldServiceSettings } from "../field-service";
import { TenantSupportSettings } from "./support-settings";

export type SettingsTab =
  | "account"
  | "appearance"
  | "security"
  | "workspace"
  | "support"
  | "team"
  | "notifications"
  | "access"
  | "integrations";

type FeedbackScope = SettingsTab | "invite" | "key";

interface AccountSummary {
  readonly displayName?: string;
  readonly email: string;
  readonly isSuperuser: boolean;
}

export function ManagementPanel({
  account,
  members,
  notifications,
  settings,
  tenantId,
  tenantName,
  invitations,
  apiKeys,
  currentUserId,
  canManageMembers = false,
  canManageTenant = false,
  canManageOwners = false,
  fieldServiceFeature,
  fieldServiceRuntimeReadiness,
  initialTab = "account",
}: {
  readonly account: AccountSummary;
  readonly members: readonly TeamMember[];
  readonly notifications: readonly NotificationSummary[];
  readonly settings?: TenantSettings | undefined;
  readonly tenantId?: string | undefined;
  readonly tenantName?: string | undefined;
  readonly invitations: readonly TenantInvitationSummary[];
  readonly apiKeys: readonly ApiKeySummary[];
  readonly currentUserId: string;
  readonly canManageMembers?: boolean;
  readonly canManageTenant?: boolean;
  readonly canManageOwners?: boolean;
  readonly fieldServiceFeature?: FieldServiceFeatureState | undefined;
  readonly fieldServiceRuntimeReadiness?:
    | {
        readonly aiProviderConfigured: boolean;
        readonly protectedFieldsConfigured: boolean;
        readonly privateStorageConfigured: boolean;
        readonly storageBackend: string;
      }
    | undefined;
  readonly initialTab?: SettingsTab;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const router = useRouter();
  const canReadCrm = useCapability("crm:read");
  const canReadVoice = useCapability("voice:read");
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  useEffect(() => setActiveTab(initialTab), [initialTab]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [messageScope, setMessageScope] = useState<FeedbackScope>("account");
  const [messageTone, setMessageTone] = useState<"critical" | "positive">(
    "positive",
  );
  const [issuedToken, setIssuedToken] = useState<string>();
  const [invitationLink, setInvitationLink] = useState<string>();
  const [currentInvitations, setCurrentInvitations] = useState(invitations);
  const [invitationToRevoke, setInvitationToRevoke] =
    useState<TenantInvitationSummary>();
  const [memberToRemove, setMemberToRemove] = useState<TeamMember>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyToRevoke, setKeyToRevoke] = useState<ApiKeySummary>();
  const dates = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: timeZone ?? "UTC",
  });
  const [supportedTimezones, setSupportedTimezones] = useState<string[]>([]);
  useEffect(() => {
    // Browser and server ICU data can differ. Expand only after hydration.
    if (typeof Intl.supportedValuesOf === "function")
      setSupportedTimezones(Intl.supportedValuesOf("timeZone"));
  }, []);
  useEffect(() => setCurrentInvitations(invitations), [invitations]);
  const unread = notifications.filter(
    (notification) => !notification.read,
  ).length;
  const accountName = account.displayName ?? account.email;
  const workspaceName = tenantName ?? accountName;
  const activeKeys = apiKeys.filter((key) => key.status === "active").length;
  const timezones = useMemo(
    () =>
      [
        ...new Set([settings?.timezone ?? "UTC", "UTC", ...supportedTimezones]),
      ].map((value) => ({ value, label: value.replaceAll("_", " ") })),
    [settings?.timezone, supportedTimezones],
  );

  async function execute(scope: FeedbackScope, operation: () => Promise<void>) {
    setPending(true);
    setMessage(undefined);
    setMessageScope(scope);
    try {
      await operation();
      router.refresh();
    } catch (error) {
      setMessageTone("critical");
      setMessage(errorMessage(error, t, "management.failed"));
    } finally {
      setPending(false);
    }
  }

  async function saveWorkspace(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const accentToken = data.get("accentToken");
    await execute("workspace", async () => {
      await crmMutation(
        "/api/settings",
        {
          tenantName: data.get("tenantName"),
          displayName: data.get("workspaceDisplayName"),
          defaultCurrency: data.get("defaultCurrency"),
          locale: data.get("locale"),
          timezone: data.get("timezone"),
          businessName: data.get("businessName"),
          businessEmail: data.get("businessEmail"),
          businessPhone: data.get("businessPhone"),
          businessAddress: data.get("businessAddress"),
          accentToken: accentToken === "" ? null : accentToken,
          reportHeader: data.get("reportHeader"),
          reportFooter: data.get("reportFooter"),
        },
        { method: "PATCH" },
      );
      setMessageTone("positive");
      setMessage(t("management.saved"));
    });
  }

  async function saveProfile(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await execute("account", async () => {
      await crmMutation(
        "/api/account/profile",
        {
          displayName: data.get("displayName"),
          email: data.get("email"),
          currentPassword: data.get("currentPassword"),
        },
        { method: "PATCH" },
      );
      setMessageTone("positive");
      setMessage(t("management.profileSaved"));
    });
  }

  async function changePassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (data.get("newPassword") !== data.get("confirmPassword")) {
      setMessageScope("security");
      setMessageTone("critical");
      setMessage(t("management.passwordMismatch"));
      return;
    }
    await execute("security", async () => {
      await crmMutation(
        "/api/account/password",
        {
          currentPassword: data.get("currentPassword"),
          newPassword: data.get("newPassword"),
        },
        { method: "PATCH" },
      );
      form.reset();
      setMessageTone("positive");
      setMessage(t("management.passwordSaved"));
    });
  }

  async function invite(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await execute("invite", async () => {
      const result = await crmMutation<{ token: string }>(
        "/api/settings/invitations",
        { email: data.get("email"), role: data.get("role") },
      );
      setInvitationLink(
        `${window.location.origin}/invite?token=${encodeURIComponent(result.token)}`,
      );
      form.reset();
      setMessageTone("positive");
      setMessage(t("management.invitationCreated"));
    });
  }

  async function changeRole(userId: string, role: TeamMember["role"]) {
    await execute("team", async () => {
      await crmMutation(
        `/api/settings/members/${userId}`,
        { role },
        { method: "PATCH" },
      );
      setMessageTone("positive");
      setMessage(t("management.roleSaved"));
    });
  }

  async function removeMember(member: TeamMember) {
    await execute("team", async () => {
      await crmMutation(
        `/api/settings/members/${member.userId}`,
        {},
        { method: "DELETE" },
      );
      setMemberToRemove(undefined);
      setMessageTone("positive");
      setMessage(t("management.memberRemoved"));
    });
  }

  async function revokeInvitation(invitation: TenantInvitationSummary) {
    await execute("team", async () => {
      await crmMutation(
        `/api/settings/invitations/${invitation.id}`,
        {},
        { method: "DELETE" },
      );
      setCurrentInvitations((records) =>
        records.filter((record) => record.id !== invitation.id),
      );
      setInvitationToRevoke(undefined);
      setMessageTone("positive");
      setMessage(t("management.invitationRevoked"));
    });
  }

  async function issueKey(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await execute("key", async () => {
      const result = await crmMutation<{ token: string }>(
        "/api/settings/api-keys",
        {
          name: data.get("name"),
          scopes:
            data.get("permissions") === "read-write"
              ? ["crm:read", "crm:write"]
              : ["crm:read"],
        },
      );
      setIssuedToken(result.token);
      form.reset();
    });
  }

  async function revokeKey(key: ApiKeySummary) {
    await execute("access", async () => {
      await crmMutation(
        `/api/settings/api-keys/${key.id}`,
        {},
        { method: "DELETE" },
      );
      setKeyToRevoke(undefined);
      setMessageTone("positive");
      setMessage(t("tenantSettings.keyRevoked"));
    });
  }

  async function copy(value: string, scope: "invite" | "key") {
    setMessageScope(scope);
    try {
      await navigator.clipboard.writeText(value);
      setMessageTone("positive");
      setMessage(t("tenantSettings.copied"));
    } catch {
      setMessageTone("critical");
      setMessage(t("tenantSettings.copyFailed"));
    }
  }

  function feedback(scope: FeedbackScope) {
    return messageScope === scope && message !== undefined ? (
      <InlineFeedback
        className="settings-feedback"
        description={message}
        tone={messageTone}
      />
    ) : null;
  }

  const tabs = [
    {
      controls: "settings-account-panel",
      id: "account",
      label: t("management.accountTab"),
      tabId: "settings-account-tab",
    },
    {
      controls: "settings-appearance-panel",
      id: "appearance",
      label: t("tenantSettings.appearance"),
      tabId: "settings-appearance-tab",
    },
    {
      controls: "settings-security-panel",
      id: "security",
      label: t("tenantSettings.security"),
      tabId: "settings-security-tab",
    },
    ...(canManageTenant
      ? [
          {
            controls: "settings-workspace-panel",
            id: "workspace",
            label: t("management.workspaceTab"),
            tabId: "settings-workspace-tab",
          },
          {
            controls: "settings-support-panel",
            id: "support",
            label: t("tenantSupportSettings.tab"),
            tabId: "settings-support-tab",
          },
        ]
      : []),
    ...(canManageMembers
      ? [
          {
            controls: "settings-team-panel",
            count: members.length,
            id: "team",
            label: t("management.teamTab"),
            tabId: "settings-team-tab",
          },
        ]
      : []),
    {
      controls: "settings-notifications-panel",
      count: unread,
      id: "notifications",
      label: t("management.notificationsTab"),
      tabId: "settings-notifications-tab",
    },
    ...(canManageTenant
      ? [
          {
            controls: "settings-access-panel",
            count: apiKeys.length,
            id: "access",
            label: t("management.accessTab"),
            tabId: "settings-access-tab",
          },
          {
            controls: "settings-integrations-panel",
            id: "integrations",
            label: t("tenantSettings.productSettings"),
            tabId: "settings-integrations-tab",
          },
        ]
      : []),
  ];

  return (
    <div className="settings-workspace">
      <section
        aria-label={locale === "he" ? "סקירת הגדרות" : "Settings at a glance"}
        className="settings-overview"
      >
        <button
          aria-pressed={activeTab === "account"}
          className="settings-overview-card"
          onClick={() => setActiveTab("account")}
          type="button"
        >
          <IdentityImage
            className="settings-overview-card__icon settings-overview-card__avatar"
            fallback={accountName.slice(0, 2).toLocaleUpperCase(locale)}
            source="/api/account/avatar"
          />
          <span>
            <small>{locale === "he" ? "חשבון" : "Account"}</small>
            <strong>{accountName}</strong>
            <em>{locale === "he" ? "פרופיל אישי" : "Personal profile"}</em>
          </span>
        </button>
        <button
          aria-pressed={activeTab === "team"}
          className="settings-overview-card"
          disabled={!canManageMembers}
          onClick={() => setActiveTab("team")}
          type="button"
        >
          <span className="settings-overview-card__icon">
            <UsersRound aria-hidden="true" size={18} />
          </span>
          <span>
            <small>{locale === "he" ? "חברי צוות" : "Team members"}</small>
            <strong>{members.length}</strong>
            <em>{locale === "he" ? "גישה פעילה" : "Active access"}</em>
          </span>
        </button>
        <button
          aria-pressed={activeTab === "notifications"}
          className="settings-overview-card"
          onClick={() => setActiveTab("notifications")}
          type="button"
        >
          <span className="settings-overview-card__icon">
            <BellRing aria-hidden="true" size={18} />
          </span>
          <span>
            <small>{locale === "he" ? "התראות" : "Notifications"}</small>
            <strong>{unread}</strong>
            <em>{locale === "he" ? "לא נקראו" : "Unread items"}</em>
          </span>
        </button>
        <button
          aria-pressed={activeTab === "access"}
          className="settings-overview-card"
          disabled={!canManageTenant}
          onClick={() => setActiveTab("access")}
          type="button"
        >
          <span className="settings-overview-card__icon">
            <ShieldCheck aria-hidden="true" size={18} />
          </span>
          <span>
            <small>{locale === "he" ? "גישה ל-API" : "API access"}</small>
            <strong>{activeKeys}</strong>
            <em>{locale === "he" ? "מפתחות פעילים" : "Active credentials"}</em>
          </span>
        </button>
      </section>
      <aside className="settings-navigation">
        <div className="settings-workspace-identity">
          <IdentityImage
            className="settings-list-icon settings-workspace-identity__logo"
            contextKey={tenantId}
            fallback={workspaceName.slice(0, 2).toLocaleUpperCase(locale)}
            source="/api/settings/logo"
          />
          <div>
            <strong>
              <bdi>{workspaceName}</bdi>
            </strong>
            <span>{t("premiumSettings.controlCenter")}</span>
          </div>
        </div>
        <div className="settings-desktop-navigation">
          <Tabs
            activeId={activeTab}
            ariaLabel={t("management.settingsViews")}
            direction={locale === "he" ? "rtl" : "ltr"}
            items={tabs}
            orientation="vertical"
            onChange={(id) => setActiveTab(id as SettingsTab)}
          />
        </div>
        <SelectInput
          aria-label={t("management.settingsViews")}
          className="settings-compact-navigation"
          value={activeTab}
          onChange={(event) => setActiveTab(event.target.value as SettingsTab)}
        >
          {tabs.map((tab) => (
            <option value={tab.id} key={tab.id}>
              {tab.label}
            </option>
          ))}
        </SelectInput>
        <p className="settings-scope-note">{t("premiumSettings.scopeHint")}</p>
      </aside>
      <div className="settings-content">
        {!canManageMembers && !canManageTenant ? (
          <InlineFeedback description={t("management.personalScopeOnly")} />
        ) : null}
        <section
          aria-labelledby="settings-account-tab"
          className="settings-panel settings-account-grid settings-account-panel"
          hidden={activeTab !== "account"}
          id="settings-account-panel"
          role="tabpanel"
        >
          <header className="settings-section-title">
            <h2>{t("management.accountTab")}</h2>
            <p>{t("tenantSettings.accountScope")}</p>
          </header>
          {feedback("account")}
          <Surface className="settings-form-surface" level="raised">
            <SectionHeader
              action={
                account.isSuperuser ? (
                  <Badge
                    label={t("management.platformAdministrator")}
                    tone="warning"
                  />
                ) : undefined
              }
              description={t("management.accountHint")}
              title={t("management.account")}
            />
            <form
              className="feature-form"
              onSubmit={(event) => void saveProfile(event)}
            >
              <fieldset className="form-fieldset" disabled={pending}>
                <Input
                  defaultValue={account.displayName ?? ""}
                  id="account-display-name"
                  label={t("management.personalDisplayName")}
                  maxLength={120}
                  name="displayName"
                />
                <Input
                  autoComplete="email"
                  defaultValue={account.email}
                  id="account-email"
                  label={t("management.email")}
                  name="email"
                  required
                  type="email"
                />
                <Input
                  autoComplete="current-password"
                  id="profile-current-password"
                  label={t("management.currentPasswordForEmail")}
                  name="currentPassword"
                  type="password"
                />
                <Button busy={pending} type="submit">
                  {t("management.saveProfile")}
                </Button>
              </fieldset>
            </form>
          </Surface>
          <aside className="settings-account-insights">
            <Surface className="settings-insight-card" level="raised">
              <span className="settings-insight-card__icon">
                <ShieldCheck aria-hidden="true" size={18} />
              </span>
              <div>
                <strong>
                  {locale === "he" ? "גישה מאובטחת" : "Secure access"}
                </strong>
                <p>
                  {account.isSuperuser
                    ? locale === "he"
                      ? "לחשבון זה יש הרשאות מנהל פלטפורמה בכל סביבות העבודה."
                      : "This account has platform administrator access across workspaces."
                    : locale === "he"
                      ? "הגישה מוגבלת להרשאות סביבת העבודה שלך."
                      : "Access is limited to your workspace permissions."}
                </p>
              </div>
            </Surface>
            <Surface className="settings-insight-card" level="raised">
              <span className="settings-insight-card__icon">
                <Palette aria-hidden="true" size={18} />
              </span>
              <div>
                <strong>
                  {locale === "he" ? "התאמה אישית" : "Personalize workspace"}
                </strong>
                <p>
                  {locale === "he"
                    ? "בחר שפה, כיוון תצוגה וערכת צבעים שמתאימים לעבודה שלך."
                    : "Choose the language, reading direction, and color theme that fit your work."}
                </p>
                <Button
                  onClick={() => setActiveTab("appearance")}
                  size="small"
                  variant="quiet"
                >
                  {locale === "he" ? "פתח מראה" : "Open appearance"}
                  <ArrowUpRight aria-hidden="true" size={15} />
                </Button>
              </div>
            </Surface>
          </aside>
        </section>

        <section
          aria-labelledby="settings-security-tab"
          className="settings-panel settings-account-grid"
          hidden={activeTab !== "security"}
          id="settings-security-panel"
          role="tabpanel"
        >
          <header className="settings-section-title">
            <h2>{t("tenantSettings.security")}</h2>
            <p>{t("tenantSettings.securityScope")}</p>
          </header>
          {feedback("security")}
          <Surface className="settings-form-surface">
            <SectionHeader
              description={t("management.passwordHint")}
              title={t("management.password")}
            />
            <form
              className="feature-form"
              onSubmit={(event) => void changePassword(event)}
            >
              <fieldset className="form-fieldset" disabled={pending}>
                <Input
                  autoComplete="current-password"
                  id="password-current"
                  label={t("management.currentPassword")}
                  name="currentPassword"
                  required
                  type="password"
                />
                <Input
                  autoComplete="new-password"
                  id="password-new"
                  label={t("management.newPassword")}
                  minLength={12}
                  name="newPassword"
                  required
                  type="password"
                />
                <Input
                  autoComplete="new-password"
                  id="password-confirm"
                  label={t("management.confirmPassword")}
                  minLength={12}
                  name="confirmPassword"
                  required
                  type="password"
                />
                <Button busy={pending} type="submit" variant="secondary">
                  <LockKeyhole aria-hidden="true" size={16} />
                  {t("management.changePassword")}
                </Button>
              </fieldset>
            </form>
          </Surface>
        </section>

        <section
          aria-labelledby="settings-appearance-tab"
          className="settings-panel"
          hidden={activeTab !== "appearance"}
          id="settings-appearance-panel"
          role="tabpanel"
        >
          <header className="settings-section-title">
            <h2>{t("tenantSettings.appearance")}</h2>
            <p>{t("tenantSettings.appearanceScope")}</p>
          </header>
          <div className="settings-preference-row">
            <div>
              <h3>{t("common.language")}</h3>
              <p>{t("tenantSettings.languageHint")}</p>
            </div>
            <LanguageControl />
          </div>
          <div className="settings-preference-row">
            <div>
              <h3>{t("tenantSettings.colorTheme")}</h3>
              <p>{t("tenantSettings.themeHint")}</p>
            </div>
            <ThemeControl />
          </div>
        </section>

        {canManageTenant &&
        settings !== undefined &&
        tenantName !== undefined ? (
          <section
            aria-labelledby="settings-workspace-tab"
            className="settings-panel"
            hidden={activeTab !== "workspace"}
            id="settings-workspace-panel"
            role="tabpanel"
          >
            <header className="settings-section-title">
              <h2>{t("management.workspaceTab")}</h2>
              <p>{t("tenantSettings.workspaceScope")}</p>
            </header>
            {feedback("workspace")}
            <Surface className="settings-form-surface" level="raised">
              <SectionHeader
                description={t("management.workspaceHint")}
                title={t("management.title")}
              />
              <form
                className="feature-form"
                onSubmit={(event) => void saveWorkspace(event)}
              >
                <fieldset className="form-fieldset" disabled={pending}>
                  <section
                    className="settings-form-section"
                    aria-labelledby="workspace-identity-heading"
                  >
                    <h3 id="workspace-identity-heading">
                      <Building2 aria-hidden="true" size={16} />
                      {t("management.identity")}
                    </h3>
                    <IdentityImageEditor
                      chooseLabel={t("management.uploadLogo")}
                      contextKey={tenantId}
                      failedLabel={t("management.imageFailed")}
                      fallback={tenantName
                        .slice(0, 2)
                        .toLocaleUpperCase(locale)}
                      hint={t("management.logoHint")}
                      removeLabel={t("management.removeLogo")}
                      removedLabel={t("management.logoRemoved")}
                      source="/api/settings/logo"
                      title={t("management.organizationLogo")}
                      updatedLabel={t("management.logoUpdated")}
                      variant="organization"
                    />
                    <div className="settings-form-grid">
                      <Input
                        defaultValue={tenantName}
                        id="tenant-name"
                        label={t("management.tenantName")}
                        maxLength={120}
                        name="tenantName"
                        required
                      />
                      <Input
                        defaultValue={settings.displayName ?? ""}
                        id="workspace-display-name"
                        label={t("management.workspaceDisplayName")}
                        name="workspaceDisplayName"
                      />
                    </div>
                  </section>
                  <section
                    className="settings-form-section"
                    aria-labelledby="workspace-branding-heading"
                  >
                    <h3 id="workspace-branding-heading">
                      <Palette aria-hidden="true" size={16} />
                      {t("management.branding")}
                    </h3>
                    <p className="public-note">
                      {t("management.brandingHint")}
                    </p>
                    <div className="settings-form-grid">
                      <Input
                        defaultValue={settings.businessName ?? ""}
                        id="business-name"
                        label={t("management.businessName")}
                        maxLength={160}
                        name="businessName"
                      />
                      <Input
                        defaultValue={settings.businessEmail ?? ""}
                        id="business-email"
                        label={t("management.businessEmail")}
                        maxLength={320}
                        name="businessEmail"
                        type="email"
                      />
                      <Input
                        defaultValue={settings.businessPhone ?? ""}
                        id="business-phone"
                        label={t("management.businessPhone")}
                        maxLength={40}
                        name="businessPhone"
                      />
                      <Select
                        defaultValue={settings.accentToken ?? ""}
                        id="workspace-accent"
                        label={t("management.accent")}
                        name="accentToken"
                      >
                        <option value="">
                          {t("management.accentDefault")}
                        </option>
                        {[
                          "blue",
                          "cyan",
                          "emerald",
                          "violet",
                          "amber",
                          "rose",
                        ].map((accent) => (
                          <option key={accent} value={accent}>
                            {accent}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Input
                      defaultValue={settings.businessAddress ?? ""}
                      id="business-address"
                      label={t("management.businessAddress")}
                      maxLength={500}
                      name="businessAddress"
                    />
                    <div className="settings-form-grid">
                      <Textarea
                        defaultValue={settings.reportHeader ?? ""}
                        id="report-header"
                        label={t("management.reportHeader")}
                        maxLength={500}
                        name="reportHeader"
                        rows={3}
                      />
                      <Textarea
                        defaultValue={settings.reportFooter ?? ""}
                        id="report-footer"
                        label={t("management.reportFooter")}
                        maxLength={1000}
                        name="reportFooter"
                        rows={3}
                      />
                    </div>
                  </section>
                  <section
                    className="settings-form-section"
                    aria-labelledby="workspace-regional-heading"
                  >
                    <h3 id="workspace-regional-heading">
                      {t("management.regional")}
                    </h3>
                    <div className="settings-form-grid">
                      <Input
                        defaultValue={settings.defaultCurrency}
                        id="currency"
                        label={t("management.currency")}
                        maxLength={3}
                        name="defaultCurrency"
                        required
                      />
                      <Select
                        defaultValue={settings.locale}
                        id="locale"
                        label={t("management.locale")}
                        name="locale"
                        required
                      >
                        {!["en", "he"].includes(settings.locale) ? (
                          <option value={settings.locale}>
                            {settings.locale}
                          </option>
                        ) : null}
                        <option value="en">English</option>
                        <option value="he">עברית</option>
                      </Select>
                      <Combobox
                        defaultValue={settings.timezone}
                        id="timezone"
                        label={t("management.timezone")}
                        name="timezone"
                        options={timezones}
                        searchLabel={t("tenantSettings.searchTimezones")}
                        emptyLabel={t("tenantSettings.noTimezones")}
                        required
                      />
                    </div>
                  </section>
                  <div className="form-actions">
                    <Button busy={pending} type="submit">
                      {t("management.save")}
                    </Button>
                  </div>
                </fieldset>
              </form>
            </Surface>
          </section>
        ) : null}

        {canManageTenant &&
        settings !== undefined &&
        tenantName !== undefined ? (
          <section
            aria-labelledby="settings-support-tab"
            className="settings-panel"
            hidden={activeTab !== "support"}
            id="settings-support-panel"
            role="tabpanel"
          >
            <TenantSupportSettings
              settings={settings}
              tenantName={tenantName}
            />
          </section>
        ) : null}

        {canManageMembers ? (
          <section
            aria-labelledby="settings-team-tab"
            className="settings-panel settings-team-grid"
            hidden={activeTab !== "team"}
            id="settings-team-panel"
            role="tabpanel"
          >
            <header className="settings-section-title">
              <h2>{t("management.teamTab")}</h2>
              <p>
                {t("tenantSettings.teamScope", {
                  members: members.length,
                  invitations: currentInvitations.length,
                })}
              </p>
            </header>
            {feedback("team")}
            <Surface className="settings-index-surface" level="raised">
              <SectionHeader
                action={
                  <Button
                    onClick={() => {
                      setMessage(undefined);
                      setInviteOpen(true);
                    }}
                  >
                    <UserPlus aria-hidden="true" size={16} />
                    {t("management.invite")}
                  </Button>
                }
                description={t("management.teamHint")}
                title={t("management.team")}
              />
              <div className="settings-member-list">
                {members.map((member) => {
                  const memberManageable =
                    member.role !== "owner" || canManageOwners;
                  return (
                    <article key={member.userId}>
                      <span className="settings-list-icon" aria-hidden="true">
                        <UserRound size={16} />
                      </span>
                      <div>
                        <strong>{member.displayName ?? member.email}</strong>
                        <small dir="ltr">{member.email}</small>
                      </div>
                      {memberManageable ? (
                        <SelectInput
                          aria-label={t("management.memberRole", {
                            email: member.email,
                          })}
                          className="or-select settings-member-role"
                          value={member.role}
                          disabled={pending}
                          id={`member-role-${member.userId}`}
                          onChange={(event) =>
                            void changeRole(
                              member.userId,
                              event.target.value as TeamMember["role"],
                            )
                          }
                        >
                          {canManageOwners ? (
                            <option value="owner">{t("status.owner")}</option>
                          ) : null}
                          <option value="admin">{t("status.admin")}</option>
                          <option value="agent">{t("status.agent")}</option>
                          <option value="technician">
                            {t("status.technician")}
                          </option>
                          <option value="viewer">{t("status.viewer")}</option>
                        </SelectInput>
                      ) : (
                        <Badge
                          label={t(`status.${member.role}`)}
                          tone="positive"
                        />
                      )}
                      {memberManageable && member.userId !== currentUserId ? (
                        <Button
                          aria-label={t("management.removeMember", {
                            email: member.email,
                          })}
                          onClick={() => {
                            setMessage(undefined);
                            setMemberToRemove(member);
                          }}
                          size="small"
                          variant="quiet"
                        >
                          <Trash2 aria-hidden="true" size={15} />
                        </Button>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </Surface>
            <Dialog
              className="settings-editor"
              open={inviteOpen}
              onClose={() => setInviteOpen(false)}
              closeLabel={t("common.close")}
              description={t("management.inviteHint")}
              title={t("management.invite")}
            >
              {feedback("invite")}
              <form
                className="feature-form"
                onSubmit={(event) => void invite(event)}
              >
                <fieldset className="form-fieldset" disabled={pending}>
                  <Input
                    id="invitation-email"
                    label={t("management.email")}
                    name="email"
                    required
                    type="email"
                  />
                  <Select
                    defaultValue="agent"
                    id="invitation-role"
                    label={t("management.role")}
                    name="role"
                  >
                    <option value="admin">{t("status.admin")}</option>
                    <option value="agent">{t("status.agent")}</option>
                    <option value="technician">{t("status.technician")}</option>
                    <option value="viewer">{t("status.viewer")}</option>
                  </Select>
                  <Button busy={pending} type="submit">
                    <UserPlus aria-hidden="true" size={16} />
                    {t("management.createInvitation")}
                  </Button>
                </fieldset>
              </form>
              {invitationLink === undefined ? null : (
                <div className="settings-invitation-link" role="status">
                  <strong>{t("management.copyInvitation")}</strong>
                  <code dir="ltr">{invitationLink}</code>
                  <Button
                    onClick={() => void copy(invitationLink, "invite")}
                    size="small"
                    variant="secondary"
                  >
                    {t("common.copy")}
                  </Button>
                </div>
              )}
            </Dialog>
            {currentInvitations.length === 0 ? null : (
              <div className="settings-invitation-list">
                <h3>{t("management.pendingInvitations")}</h3>
                {currentInvitations.map((invitation) => (
                  <article key={invitation.id}>
                    <span dir="ltr">{invitation.email}</span>
                    <Badge
                      label={t(`status.${invitation.role}`)}
                      tone="neutral"
                    />
                    <time dateTime={invitation.expiresAt}>
                      {dates.format(new Date(invitation.expiresAt))}
                    </time>
                    <Button
                      aria-label={t("management.revokeInvitationFor", {
                        email: invitation.email,
                      })}
                      disabled={pending}
                      onClick={() => setInvitationToRevoke(invitation)}
                      size="small"
                      variant="quiet"
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      {t("management.revokeInvitation")}
                    </Button>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : null}

        <section
          aria-labelledby="settings-notifications-tab"
          className="settings-panel"
          hidden={activeTab !== "notifications"}
          id="settings-notifications-panel"
          role="tabpanel"
        >
          <header className="settings-section-title">
            <h2>{t("management.notificationsTab")}</h2>
            <p>
              {t("tenantSettings.notificationScope", {
                unread,
                count: notifications.length,
              })}
            </p>
          </header>
          <Surface className="settings-index-surface">
            {notifications.length === 0 ? (
              <EmptyState
                description={t("management.emptyHint")}
                title={t("management.empty")}
              />
            ) : (
              <div className="settings-notification-list">
                {notifications.map((notification) => (
                  <article key={notification.id}>
                    <div>
                      <strong>{notification.title}</strong>
                      <p>{notification.body}</p>
                      <time dateTime={notification.createdAt}>
                        {dates.format(new Date(notification.createdAt))}
                      </time>
                    </div>
                    <StatusIndicator
                      label={t(
                        notification.read ? "status.read" : "status.unread",
                      )}
                      tone={notification.read ? "neutral" : "info"}
                    />
                  </article>
                ))}
              </div>
            )}
          </Surface>
        </section>

        {canManageTenant ? (
          <section
            aria-labelledby="settings-access-tab"
            className="settings-panel settings-access-grid"
            hidden={activeTab !== "access"}
            id="settings-access-panel"
            role="tabpanel"
          >
            <header className="settings-section-title">
              <h2>{t("management.accessTab")}</h2>
              <p>{t("tenantSettings.apiScope")}</p>
            </header>
            {feedback("access")}
            <Surface className="settings-index-surface">
              <SectionHeader
                action={
                  <Button
                    onClick={() => {
                      setMessage(undefined);
                      setKeyOpen(true);
                    }}
                  >
                    <KeyRound aria-hidden="true" size={16} />
                    {t("management.issue")}
                  </Button>
                }
                description={t("management.accessHint")}
                title={t("management.keys")}
              />
              <div className="settings-key-list">
                {apiKeys.length === 0 ? (
                  <p className="muted">{t("management.noKeys")}</p>
                ) : (
                  apiKeys.map((key) => (
                    <article key={key.id}>
                      <span className="settings-list-icon" aria-hidden="true">
                        <KeyRound size={16} />
                      </span>
                      <div>
                        <strong>{key.name}</strong>
                        <code dir="ltr">
                          {key.prefix}… · {key.scopes.join(", ")}
                        </code>
                        <small>
                          {t("tenantSettings.created")}{" "}
                          <time dateTime={key.createdAt}>
                            {dates.format(new Date(key.createdAt))}
                          </time>{" "}
                          · {t("tenantSettings.lastUsed")}{" "}
                          {key.lastUsedAt === null ? (
                            t("tenantSettings.neverUsed")
                          ) : (
                            <time dateTime={key.lastUsedAt}>
                              {dates.format(new Date(key.lastUsedAt))}
                            </time>
                          )}
                        </small>
                      </div>
                      <Badge
                        label={t(`status.${key.status}`)}
                        tone={key.status === "active" ? "positive" : "neutral"}
                      />
                      {key.status === "active" ? (
                        <Button
                          disabled={pending}
                          onClick={() => {
                            setMessage(undefined);
                            setKeyToRevoke(key);
                          }}
                          size="small"
                          variant="quiet"
                        >
                          {t("tenantSettings.revoke")}
                        </Button>
                      ) : null}
                    </article>
                  ))
                )}
              </div>
            </Surface>
            <Dialog
              className="settings-editor"
              open={keyOpen}
              onClose={() => setKeyOpen(false)}
              closeLabel={t("common.close")}
              title={t("management.issue")}
              description={t("management.copyOnce")}
            >
              {feedback("key")}
              <form
                className="feature-form"
                onSubmit={(event) => void issueKey(event)}
              >
                <Input
                  disabled={pending}
                  id="api-key-name"
                  label={t("management.keyName")}
                  name="name"
                  required
                />
                <Select
                  id="api-key-permissions"
                  name="permissions"
                  label={t("tenantSettings.keyPermissions")}
                  defaultValue="read"
                  disabled={pending}
                  hint={t("tenantSettings.keyPermissionsHint")}
                >
                  <option value="read">{t("tenantSettings.readOnly")}</option>
                  <option value="read-write">
                    {t("tenantSettings.readWrite")}
                  </option>
                </Select>
                <Button
                  busy={pending}
                  disabled={pending}
                  type="submit"
                  variant="secondary"
                >
                  {t("management.issue")}
                </Button>
              </form>
              {issuedToken === undefined ? null : (
                <div className="settings-issued-token" role="status">
                  <strong>{t("management.copyOnce")}</strong>
                  <code dir="ltr">{issuedToken}</code>
                  <Button
                    onClick={() => void copy(issuedToken, "key")}
                    size="small"
                    variant="secondary"
                  >
                    {t("common.copy")}
                  </Button>
                </div>
              )}
            </Dialog>
          </section>
        ) : null}

        {canManageTenant ? (
          <section
            aria-labelledby="settings-integrations-tab"
            className="settings-panel"
            hidden={activeTab !== "integrations"}
            id="settings-integrations-panel"
            role="tabpanel"
          >
            <header className="settings-section-title">
              <h2>{t("tenantSettings.productSettings")}</h2>
              <p>{t("tenantSettings.productScope")}</p>
            </header>
            <div className="settings-product-links">
              {/* This tab is shown only to tenant managers, like the page. */}
              <Link href="/settings/business">
                <div>
                  <strong>{t("shell.businessConfiguration")}</strong>
                  <p>{t("tenantSettings.businessConfigurationHint")}</p>
                </div>
                <ArrowUpRight aria-hidden="true" size={18} />
              </Link>
              {canReadCrm ? (
                <Link href="/operations">
                  <div>
                    <strong>{t("shell.campaigns")}</strong>
                    <p>{t("tenantSettings.messagingHint")}</p>
                  </div>
                  <ArrowUpRight aria-hidden="true" size={18} />
                </Link>
              ) : null}
              {canReadVoice ? (
                <Link href="/voice">
                  <div>
                    <strong>{t("shell.voice")}</strong>
                    <p>{t("tenantSettings.voiceHint")}</p>
                  </div>
                  <ArrowUpRight aria-hidden="true" size={18} />
                </Link>
              ) : null}
              {canReadCrm ? (
                <Link href="/orchestration">
                  <div>
                    <strong>{t("shell.agents")}</strong>
                    <p>{t("tenantSettings.agentHint")}</p>
                  </div>
                  <ArrowUpRight aria-hidden="true" size={18} />
                </Link>
              ) : null}
            </div>
            {fieldServiceFeature === undefined ? null : (
              <FieldServiceSettings
                initialState={fieldServiceFeature}
                timezone={settings?.timezone ?? timeZone ?? "UTC"}
                {...(fieldServiceRuntimeReadiness === undefined
                  ? {}
                  : { runtimeReadiness: fieldServiceRuntimeReadiness })}
              />
            )}
          </section>
        ) : null}
      </div>
      <ConfirmDialog
        busy={pending}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("management.removeAction")}
        destructive
        {...(memberToRemove === undefined
          ? {}
          : {
              description: t("management.removeImpact", {
                email: memberToRemove.email,
              }),
            })}
        onCancel={() => {
          if (!pending) setMemberToRemove(undefined);
        }}
        onConfirm={() => {
          if (memberToRemove !== undefined) void removeMember(memberToRemove);
        }}
        open={memberToRemove !== undefined}
        title={t("management.removeTitle")}
      >
        {messageTone === "critical" ? feedback("team") : null}
      </ConfirmDialog>
      <ConfirmDialog
        busy={pending}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("management.revokeInvitation")}
        destructive
        description={t("management.revokeInvitationHint", {
          email: invitationToRevoke?.email ?? "",
        })}
        onCancel={() => {
          if (!pending) setInvitationToRevoke(undefined);
        }}
        onConfirm={() => {
          if (invitationToRevoke !== undefined)
            void revokeInvitation(invitationToRevoke);
        }}
        open={invitationToRevoke !== undefined}
        title={t("management.revokeInvitationTitle")}
      >
        {messageTone === "critical" ? feedback("team") : null}
      </ConfirmDialog>
      <ConfirmDialog
        busy={pending}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("tenantSettings.revoke")}
        destructive
        title={t("tenantSettings.revokeTitle")}
        description={t("tenantSettings.revokeHint", {
          name: keyToRevoke?.name ?? "",
        })}
        open={keyToRevoke !== undefined}
        onCancel={() => {
          if (!pending) setKeyToRevoke(undefined);
        }}
        onConfirm={() => {
          if (keyToRevoke !== undefined) void revokeKey(keyToRevoke);
        }}
      >
        {messageTone === "critical" ? feedback("access") : null}
      </ConfirmDialog>
    </div>
  );
}
