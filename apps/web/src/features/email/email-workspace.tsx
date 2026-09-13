"use client";

import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Cloud,
  Inbox,
  KeyRound,
  Mail,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { useLocale, useTimeZone } from "next-intl";
import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { Button, Input } from "@or-on/ui";
import { crmMutation } from "../crm";

import styles from "./email-workspace.module.css";

type EmailView = "accounts" | "setup";
type SetupProvider = "google" | "microsoft";

export interface EmailChannel {
  readonly id: string;
  readonly provider: string;
  readonly providerAccountId: string | null;
  readonly displayAddress: string | null;
  readonly status: "disabled" | "active" | "degraded" | "revoked";
  readonly createdAt: string;
  readonly updatedAt: string;
}

const copy = {
  en: {
    title: "Email",
    description: "Connect and monitor shared tenant mailboxes.",
    accounts: "Accounts",
    setup: "Connection guide",
    connected: "Connected",
    notConnected: "Not connected",
    attention: "Needs attention",
    unavailable: "OAuth setup required",
    unavailableBody:
      "Provider sign-in stays off until OAuth credentials, encrypted token storage, and mailbox sync are configured. Choose a provider below to open its exact setup checklist.",
    tenantMail: "Tenant email",
    sharedInbox: "Open conversations",
    productSettings: "Product settings",
    configuredAccounts: "Configured accounts",
    configuredHint: "Live email channels currently stored for this workspace.",
    noAccounts: "No email channels are configured yet.",
    provider: "Provider",
    address: "Mailbox",
    status: "Status",
    lastUpdated: "Last updated",
    gmail: "Gmail",
    gmailHint: "Connect a Google Workspace or Gmail mailbox.",
    outlook: "Outlook",
    outlookHint: "Connect a Microsoft 365 or Outlook mailbox.",
    connectGmail: "Connect Gmail",
    connectOutlook: "Connect Outlook",
    setupGmail: "Set up Gmail securely",
    setupOutlook: "Set up Outlook securely",
    selectedProvider: "Selected provider",
    googleRegistration: "Create a Google Cloud OAuth web client",
    googleRegistrationHint:
      "Configure the OAuth consent screen, create a Web application client, and add the platform's approved callback URL.",
    microsoftRegistration: "Create a Microsoft Entra app registration",
    microsoftRegistrationHint:
      "Register a Web application in Microsoft Entra ID, select the required mail permissions, and add the platform's approved callback URL.",
    managed: "Stored in workspace",
    setupTitle: "Secure connection checklist",
    setupHint:
      "These backend capabilities are required before live provider authorization can be enabled.",
    registration: "Register provider OAuth applications",
    registrationHint:
      "Create Google and Microsoft app registrations with approved redirect URIs.",
    secrets: "Store credentials and refresh tokens encrypted",
    secretsHint:
      "Tokens must use the platform credential vault; they must never reach browser storage.",
    sync: "Enable mailbox synchronization",
    syncHint:
      "Add durable background sync, provider webhooks, retries, and tenant-scoped audit events.",
    blocked: "Not configured",
    ready: "Detected",
    connectionState: "Connection state",
    providerAccounts: "Provider accounts",
    unknownProvider: "Other email provider",
    clientId: "OAuth client ID",
    clientSecret: "OAuth client secret",
    directoryTenant: "Microsoft directory tenant (optional)",
    saveConnect: "Save securely and continue",
    saving: "Saving…",
    credentialHint:
      "Entered here, encrypted on the server, and never returned to the browser. The deployment encryption key remains managed by the platform operator.",
    credentialError:
      "OAuth credentials could not be saved. Your entries are still here.",
  },
  he: {
    title: "אימייל",
    description: "חיבור וניטור תיבות דואר משותפות של סביבת העבודה.",
    accounts: "חשבונות",
    setup: "מדריך חיבור",
    connected: "מחובר",
    notConnected: "לא מחובר",
    attention: "דורש טיפול",
    unavailable: "נדרשת הגדרת OAuth",
    unavailableBody:
      "ההתחברות לספק נשארת כבויה עד להגדרת פרטי OAuth, אחסון מוצפן לטוקנים וסנכרון תיבת הדואר. יש לבחור ספק למטה כדי לפתוח את רשימת ההגדרות המדויקת שלו.",
    tenantMail: "אימייל סביבת העבודה",
    sharedInbox: "פתיחת שיחות",
    productSettings: "הגדרות מוצר",
    configuredAccounts: "חשבונות מוגדרים",
    configuredHint: "ערוצי האימייל החיים השמורים כעת עבור סביבת עבודה זו.",
    noAccounts: "עדיין לא הוגדרו ערוצי אימייל.",
    provider: "ספק",
    address: "תיבת דואר",
    status: "מצב",
    lastUpdated: "עודכן לאחרונה",
    gmail: "Gmail",
    gmailHint: "חיבור תיבת Google Workspace או Gmail.",
    outlook: "Outlook",
    outlookHint: "חיבור תיבת Microsoft 365 או Outlook.",
    connectGmail: "חיבור Gmail",
    connectOutlook: "חיבור Outlook",
    setupGmail: "הגדרה מאובטחת של Gmail",
    setupOutlook: "הגדרה מאובטחת של Outlook",
    selectedProvider: "הספק שנבחר",
    googleRegistration: "יצירת לקוח OAuth ב-Google Cloud",
    googleRegistrationHint:
      "יש להגדיר מסך הסכמה ל-OAuth, ליצור לקוח מסוג Web application ולהוסיף את כתובת החזרה המאושרת של הפלטפורמה.",
    microsoftRegistration: "יצירת רישום אפליקציה ב-Microsoft Entra",
    microsoftRegistrationHint:
      "יש לרשום אפליקציית Web ב-Microsoft Entra ID, לבחור את הרשאות הדואר הנדרשות ולהוסיף את כתובת החזרה המאושרת של הפלטפורמה.",
    managed: "שמור בסביבת העבודה",
    setupTitle: "רשימת בדיקה לחיבור מאובטח",
    setupHint: "יכולות השרת הבאות נדרשות לפני הפעלת אימות חי מול ספקים.",
    registration: "רישום אפליקציות OAuth אצל הספקים",
    registrationHint:
      "יצירת רישומי Google ו-Microsoft עם כתובות הפניה מאושרות.",
    secrets: "שמירת פרטי גישה וטוקני רענון בהצפנה",
    secretsHint:
      "הטוקנים חייבים להישמר בכספת הפלטפורמה ולעולם לא באחסון הדפדפן.",
    sync: "הפעלת סנכרון תיבות דואר",
    syncHint:
      "הוספת סנכרון רקע עמיד, webhooks, ניסיונות חוזרים ואירועי ביקורת מופרדי דייר.",
    blocked: "לא מוגדר",
    ready: "זוהה",
    connectionState: "מצב החיבור",
    providerAccounts: "חשבונות ספק",
    unknownProvider: "ספק אימייל אחר",
    clientId: "מזהה לקוח OAuth",
    clientSecret: "סוד לקוח OAuth",
    directoryTenant: "דייר Microsoft Directory (אופציונלי)",
    saveConnect: "שמירה מאובטחת והמשך",
    saving: "שומר…",
    credentialHint:
      "הפרטים מוזנים כאן, מוצפנים בשרת ולעולם אינם מוחזרים לדפדפן. מפתח ההצפנה של הפריסה מנוהל בידי מפעיל הפלטפורמה.",
    credentialError:
      "לא הצלחנו לשמור את פרטי OAuth. הנתונים שהוזנו נשמרו בטופס.",
  },
} as const;

function providerKind(provider: string): "google" | "microsoft" | "other" {
  const normalized = provider.toLowerCase();
  if (normalized.includes("google") || normalized.includes("gmail"))
    return "google";
  if (
    normalized.includes("microsoft") ||
    normalized.includes("outlook") ||
    normalized.includes("office")
  )
    return "microsoft";
  return "other";
}

export function EmailWorkspace({
  channels,
  tenantName,
}: {
  readonly channels: readonly EmailChannel[];
  readonly tenantName: string;
}) {
  const locale = useLocale();
  const timeZone = useTimeZone();
  const c = locale.startsWith("he") ? copy.he : copy.en;
  const [view, setView] = useState<EmailView>("accounts");
  const [setupProvider, setSetupProvider] = useState<SetupProvider | null>(
    null,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [directoryTenant, setDirectoryTenant] = useState("");
  const [credentialPending, setCredentialPending] = useState(false);
  const [credentialError, setCredentialError] = useState<string>();
  const guideRef = useRef<HTMLElement>(null);
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: timeZone ?? "UTC",
      }),
    [locale, timeZone],
  );
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const google = channels.filter(
    (channel) => providerKind(channel.provider) === "google",
  );
  const microsoft = channels.filter(
    (channel) => providerKind(channel.provider) === "microsoft",
  );
  const other = channels.filter(
    (channel) => providerKind(channel.provider) === "other",
  );
  const activeCount = channels.filter(
    (channel) => channel.status === "active",
  ).length;

  useEffect(() => {
    if (view === "setup" && setupProvider) guideRef.current?.focus();
  }, [setupProvider, view]);

  function openProviderSetup(provider: SetupProvider) {
    setSetupProvider(provider);
    setView("setup");
  }

  async function saveAndConnect(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!setupProvider || credentialPending) return;
    setCredentialPending(true);
    setCredentialError(undefined);
    try {
      await crmMutation("/api/email/oauth/configuration", {
        provider: setupProvider,
        clientId,
        clientSecret,
        directoryTenant,
      });
      window.location.href = new URL(
        `/api/email/oauth/${setupProvider}/start`,
        window.location.origin,
      ).href;
    } catch {
      setCredentialError(c.credentialError);
      setCredentialPending(false);
    }
  }

  function statusLabel(status: EmailChannel["status"]): string {
    if (status === "active") return c.connected;
    if (status === "degraded") return c.attention;
    return c.notConnected;
  }

  const providerCard = (
    provider: "google" | "microsoft",
    accounts: readonly EmailChannel[],
  ) => {
    const isGoogle = provider === "google";
    const active = accounts.find((channel) => channel.status === "active");
    const label = isGoogle ? c.gmail : c.outlook;
    return (
      <article className={styles.providerCard}>
        <div
          className={isGoogle ? styles.googleMark : styles.microsoftMark}
          aria-hidden="true"
        >
          {isGoogle ? "G" : "M"}
        </div>
        <div className={styles.providerCopy}>
          <h2>{label}</h2>
          <p>{isGoogle ? c.gmailHint : c.outlookHint}</p>
        </div>
        <span className={active ? styles.connectedBadge : styles.blockedBadge}>
          {active ? (
            <Check aria-hidden="true" size={12} />
          ) : (
            <CircleAlert aria-hidden="true" size={12} />
          )}
          {active ? c.connected : c.unavailable}
        </span>
        {active ? (
          <div className={styles.connectedAccount}>
            <strong>
              <bdi>
                {active.displayAddress ?? active.providerAccountId ?? label}
              </bdi>
            </strong>
            <small>{c.managed}</small>
          </div>
        ) : (
          <button
            aria-controls="email-connection-guide"
            aria-describedby="email-oauth-notice"
            className={styles.setupButton}
            onClick={() => openProviderSetup(provider)}
            type="button"
          >
            {isGoogle ? c.connectGmail : c.connectOutlook}
          </button>
        )}
      </article>
    );
  };

  return (
    <div className={styles.mailFrame}>
      <aside className={styles.sidebar}>
        <div className={styles.accountIdentity}>
          <span aria-hidden="true">{tenantName.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{tenantName}</strong>
            <small>{c.tenantMail}</small>
          </div>
        </div>
        <nav aria-label={c.title}>
          <button
            aria-pressed={view === "accounts"}
            onClick={() => setView("accounts")}
            type="button"
          >
            <Mail aria-hidden="true" size={15} />
            <span>{c.accounts}</span>
            <small>{number.format(channels.length)}</small>
          </button>
          <button
            aria-pressed={view === "setup"}
            onClick={() => {
              setSetupProvider(null);
              setView("setup");
            }}
            type="button"
          >
            <KeyRound aria-hidden="true" size={15} />
            <span>{c.setup}</span>
          </button>
          <p>{c.tenantMail}</p>
          <Link href="/inbox">
            <Inbox aria-hidden="true" size={15} />
            <span>{c.sharedInbox}</span>
            <ChevronRight
              aria-hidden="true"
              className="directional-icon"
              size={14}
            />
          </Link>
          <Link href="/settings">
            <Settings2 aria-hidden="true" size={15} />
            <span>{c.productSettings}</span>
            <ChevronRight
              aria-hidden="true"
              className="directional-icon"
              size={14}
            />
          </Link>
        </nav>
        <div className={styles.sidebarStatus}>
          <span>
            <i data-connected={activeCount > 0 ? "true" : "false"} />
            {activeCount > 0 ? c.connected : c.notConnected}
          </span>
          <small>
            {number.format(activeCount)}/{number.format(channels.length)}{" "}
            {c.providerAccounts}
          </small>
        </div>
      </aside>

      <section className={styles.content}>
        <header className={styles.contentHeader}>
          <div>
            <h1>{c.title}</h1>
            <p>{c.description}</p>
          </div>
          <span
            className={
              activeCount > 0 ? styles.connectedBadge : styles.blockedBadge
            }
          >
            <Cloud aria-hidden="true" size={13} />
            {activeCount > 0 ? c.connected : c.notConnected}
          </span>
        </header>

        {view === "accounts" ? (
          <div className={styles.contentBody}>
            <aside className={styles.oauthNotice} id="email-oauth-notice">
              <ShieldCheck aria-hidden="true" size={19} />
              <div>
                <strong>{c.unavailable}</strong>
                <p>{c.unavailableBody}</p>
              </div>
            </aside>
            <div className={styles.providerGrid}>
              {providerCard("google", google)}
              {providerCard("microsoft", microsoft)}
            </div>
            <section className={styles.channelsCard}>
              <header>
                <div>
                  <h2>{c.configuredAccounts}</h2>
                  <p>{c.configuredHint}</p>
                </div>
                <RefreshCw aria-hidden="true" size={15} />
              </header>
              {channels.length === 0 ? (
                <div className={styles.empty}>
                  <Mail aria-hidden="true" size={23} />
                  <p>{c.noAccounts}</p>
                </div>
              ) : (
                <div className={styles.channelList}>
                  {channels.map((channel) => (
                    <article key={channel.id}>
                      <span className={styles.mailIcon}>
                        <Mail aria-hidden="true" size={15} />
                      </span>
                      <div>
                        <strong>
                          <bdi>
                            {channel.displayAddress ??
                              channel.providerAccountId ??
                              (providerKind(channel.provider) === "other"
                                ? c.unknownProvider
                                : channel.provider)}
                          </bdi>
                        </strong>
                        <small>
                          {c.provider}: {channel.provider}
                        </small>
                      </div>
                      <span
                        className={
                          channel.status === "active"
                            ? styles.connectedBadge
                            : styles.blockedBadge
                        }
                      >
                        {statusLabel(channel.status)}
                      </span>
                      <time dateTime={channel.updatedAt}>
                        {c.lastUpdated}:{" "}
                        {formatter.format(new Date(channel.updatedAt))}
                      </time>
                    </article>
                  ))}
                </div>
              )}
              {other.length > 0 ? (
                <p className={styles.otherNote}>
                  {number.format(other.length)} {c.unknownProvider}
                </p>
              ) : null}
            </section>
          </div>
        ) : (
          <div className={styles.contentBody}>
            <section
              aria-labelledby="email-connection-guide-title"
              className={styles.guide}
              id="email-connection-guide"
              ref={guideRef}
              tabIndex={-1}
            >
              <header>
                <span>
                  <KeyRound aria-hidden="true" size={18} />
                </span>
                <div>
                  <h2 id="email-connection-guide-title">
                    {setupProvider === "google"
                      ? c.setupGmail
                      : setupProvider === "microsoft"
                        ? c.setupOutlook
                        : c.setupTitle}
                  </h2>
                  <p>
                    {setupProvider
                      ? `${c.selectedProvider}: ${
                          setupProvider === "google" ? c.gmail : c.outlook
                        }. ${c.setupHint}`
                      : c.setupHint}
                  </p>
                </div>
              </header>
              <ol>
                <li>
                  <span>1</span>
                  <div>
                    <strong>
                      {setupProvider === "google"
                        ? c.googleRegistration
                        : setupProvider === "microsoft"
                          ? c.microsoftRegistration
                          : c.registration}
                    </strong>
                    <p>
                      {setupProvider === "google"
                        ? c.googleRegistrationHint
                        : setupProvider === "microsoft"
                          ? c.microsoftRegistrationHint
                          : c.registrationHint}
                    </p>
                  </div>
                  <b>{c.blocked}</b>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>{c.secrets}</strong>
                    <p>{c.secretsHint}</p>
                  </div>
                  <b>{c.blocked}</b>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <strong>{c.sync}</strong>
                    <p>{c.syncHint}</p>
                  </div>
                  <b>{c.blocked}</b>
                </li>
              </ol>
              {setupProvider ? (
                <form
                  className={styles.oauthForm}
                  onSubmit={(event) => void saveAndConnect(event)}
                >
                  <Input
                    autoComplete="off"
                    id={`oauth-${setupProvider}-client-id`}
                    label={c.clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    required
                    value={clientId}
                  />
                  <Input
                    autoComplete="new-password"
                    id={`oauth-${setupProvider}-client-secret`}
                    label={c.clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                    required
                    type="password"
                    value={clientSecret}
                  />
                  {setupProvider === "microsoft" ? (
                    <Input
                      id="oauth-microsoft-directory"
                      label={c.directoryTenant}
                      onChange={(event) =>
                        setDirectoryTenant(event.target.value)
                      }
                      value={directoryTenant}
                    />
                  ) : null}
                  <p>{c.credentialHint}</p>
                  {credentialError ? (
                    <p role="alert">{credentialError}</p>
                  ) : null}
                  <Button disabled={credentialPending} type="submit">
                    {credentialPending ? c.saving : c.saveConnect}
                  </Button>
                </form>
              ) : null}
            </section>
            <Link className={styles.settingsLink} href="/settings">
              <div>
                <Settings2 aria-hidden="true" size={17} />
                <span>
                  <strong>{c.productSettings}</strong>
                  <small>{c.setupHint}</small>
                </span>
              </div>
              <ArrowUpRight aria-hidden="true" size={16} />
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
