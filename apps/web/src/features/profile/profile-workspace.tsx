"use client";

import { Button, Input } from "@or-on/ui";
import {
  BadgeCheck,
  Check,
  Globe2,
  KeyRound,
  LockKeyhole,
  Mail,
  Pencil,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import {
  useMemo,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from "react";

import { LanguageControl } from "../../i18n/language-control";
import { ThemeControl } from "../../i18n/theme-control";
import { crmMutation } from "../crm";
import { IdentityImage, IdentityImageEditor } from "../identity";
import styles from "./profile-workspace.module.css";

type ProfileTab = "overview" | "account" | "security" | "appearance";

export interface ProfileWorkspaceProps {
  readonly account: {
    readonly displayName?: string;
    readonly email: string;
    readonly isSuperuser: boolean;
  };
  readonly tenant: {
    readonly tenantName: string;
    readonly role: "owner" | "admin" | "agent" | "technician" | "viewer";
  };
  readonly membershipCount: number;
}

const copy = {
  en: {
    breadcrumb: "Workspace / People / My profile",
    profile: "Profile",
    active: "Active account",
    platformAdmin: "Platform administrator",
    edit: "Edit profile",
    email: "Email",
    overview: "Overview",
    account: "Account",
    security: "Security",
    appearance: "Appearance",
    about: "About this account",
    aboutBody:
      "Your profile identifies you across conversations, assignments, audit events, and tenant administration.",
    workDetails: "Workspace details",
    currentWorkspace: "Current workspace",
    accessRole: "Access role",
    memberships: "Workspace memberships",
    signIn: "Sign-in address",
    access: "Access status",
    accessBody:
      "This session is authenticated and scoped to the current workspace. Permissions are enforced by the server and PostgreSQL row-level security.",
    profileComplete: "Profile complete",
    profileNeedsName: "Add a display name to complete your profile.",
    personalTitle: "Personal account",
    personalHint:
      "Update the name teammates see and the email you use to sign in.",
    photoTitle: "Profile picture",
    photoHint: "PNG, JPEG or WebP. Maximum file size 2 MB.",
    uploadPhoto: "Upload picture",
    removePhoto: "Remove",
    photoUpdated: "Profile picture updated.",
    photoRemoved: "Profile picture removed.",
    photoFailed: "Choose a valid image up to 2 MB.",
    displayName: "Display name",
    emailAddress: "Email address",
    currentPasswordEmail: "Current password (required only to change email)",
    save: "Save changes",
    saved: "Profile saved.",
    passwordTitle: "Change password",
    passwordHint:
      "Use at least 12 characters. Changing your password revokes your other sessions.",
    currentPassword: "Current password",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    changePassword: "Update password",
    passwordSaved: "Password updated.",
    mismatch: "The new passwords do not match.",
    preferences: "Preferences",
    preferencesHint:
      "Language and color theme apply to this browser and your current product experience.",
    language: "Language",
    languageHint: "Choose English or Hebrew. Direction changes automatically.",
    theme: "Color theme",
    themeHint: "Use light, dark, or your system preference.",
    failed: "The change could not be saved. Please try again.",
    roles: {
      owner: "Owner",
      admin: "Admin",
      agent: "Agent",
      technician: "Technician",
      viewer: "Viewer",
    },
  },
  he: {
    breadcrumb: "סביבת עבודה / אנשים / הפרופיל שלי",
    profile: "פרופיל",
    active: "חשבון פעיל",
    platformAdmin: "מנהל מערכת",
    edit: "עריכת פרופיל",
    email: "אימייל",
    overview: "סקירה",
    account: "חשבון",
    security: "אבטחה",
    appearance: "תצוגה",
    about: "על החשבון",
    aboutBody:
      "הפרופיל מזהה אותך בשיחות, בהקצאות, באירועי ביקורת ובניהול סביבת העבודה.",
    workDetails: "פרטי סביבת העבודה",
    currentWorkspace: "סביבת עבודה נוכחית",
    accessRole: "תפקיד גישה",
    memberships: "חברויות בסביבות עבודה",
    signIn: "כתובת התחברות",
    access: "מצב גישה",
    accessBody:
      "ההפעלה מאומתת ומוגבלת לסביבת העבודה הנוכחית. ההרשאות נאכפות בשרת ובאבטחת השורות של PostgreSQL.",
    profileComplete: "הפרופיל הושלם",
    profileNeedsName: "יש להוסיף שם תצוגה כדי להשלים את הפרופיל.",
    personalTitle: "חשבון אישי",
    personalHint: "עדכנו את השם שיוצג לצוות ואת האימייל המשמש להתחברות.",
    photoTitle: "תמונת פרופיל",
    photoHint: "PNG, JPEG או WebP. גודל מרבי של 2 MB.",
    uploadPhoto: "העלאת תמונה",
    removePhoto: "הסרה",
    photoUpdated: "תמונת הפרופיל עודכנה.",
    photoRemoved: "תמונת הפרופיל הוסרה.",
    photoFailed: "יש לבחור תמונה תקינה בגודל של עד 2 MB.",
    displayName: "שם תצוגה",
    emailAddress: "כתובת אימייל",
    currentPasswordEmail: "סיסמה נוכחית (נדרשת רק לשינוי אימייל)",
    save: "שמירת שינויים",
    saved: "הפרופיל נשמר.",
    passwordTitle: "שינוי סיסמה",
    passwordHint: "יש להשתמש ב-12 תווים לפחות. שינוי הסיסמה מבטל הפעלות אחרות.",
    currentPassword: "סיסמה נוכחית",
    newPassword: "סיסמה חדשה",
    confirmPassword: "אימות סיסמה חדשה",
    changePassword: "עדכון סיסמה",
    passwordSaved: "הסיסמה עודכנה.",
    mismatch: "הסיסמאות החדשות אינן תואמות.",
    preferences: "העדפות",
    preferencesHint: "השפה וערכת הצבעים חלות בדפדפן ובחוויית המוצר הנוכחית.",
    language: "שפה",
    languageHint: "בחרו אנגלית או עברית. כיוון הממשק ישתנה אוטומטית.",
    theme: "ערכת צבעים",
    themeHint: "בחרו מצב בהיר, כהה או התאמה למערכת.",
    failed: "לא ניתן היה לשמור את השינוי. נסו שוב.",
    roles: {
      owner: "בעלים",
      admin: "מנהל",
      agent: "נציג",
      technician: "טכנאי",
      viewer: "צופה",
    },
  },
} as const;

function initials(value: string): string {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  return (
    parts.length > 1
      ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`
      : value.slice(0, 2)
  ).toUpperCase();
}

export function ProfileWorkspace({
  account,
  tenant,
  membershipCount,
}: ProfileWorkspaceProps) {
  const locale = useLocale();
  const c = locale.startsWith("he") ? copy.he : copy.en;
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ProfileTab>("overview");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    readonly tone: "error" | "success";
    readonly text: string;
  }>();
  const name =
    [
      account.displayName?.trim(),
      account.email.split("@")[0],
      account.email,
    ].find((candidate) => candidate !== undefined && candidate !== "") ??
    account.email;
  const completion = account.displayName?.trim() ? 100 : 66;
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  async function saveProfile(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setFeedback(undefined);
    try {
      await crmMutation(
        "/api/account/profile",
        {
          displayName: data.get("displayName"),
          email: data.get("email"),
          currentPassword: data.get("currentPassword"),
        },
        { method: "PATCH" },
      );
      setFeedback({ tone: "success", text: c.saved });
      router.refresh();
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : c.failed,
      });
    } finally {
      setPending(false);
    }
  }

  async function savePassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (data.get("newPassword") !== data.get("confirmPassword")) {
      setFeedback({ tone: "error", text: c.mismatch });
      return;
    }
    setPending(true);
    setFeedback(undefined);
    try {
      await crmMutation(
        "/api/account/password",
        {
          currentPassword: data.get("currentPassword"),
          newPassword: data.get("newPassword"),
        },
        { method: "PATCH" },
      );
      form.reset();
      setFeedback({ tone: "success", text: c.passwordSaved });
      router.refresh();
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : c.failed,
      });
    } finally {
      setPending(false);
    }
  }

  const tabs: readonly { readonly id: ProfileTab; readonly label: string }[] = [
    { id: "overview", label: c.overview },
    { id: "account", label: c.account },
    { id: "security", label: c.security },
    { id: "appearance", label: c.appearance },
  ];

  return (
    <div className={styles.workspace}>
      <p className={styles.breadcrumb}>{c.breadcrumb}</p>
      <header className={styles.hero}>
        <div className={styles.identity}>
          <div
            className={styles.avatarRing}
            style={
              { "--profile-completion": String(completion) } as CSSProperties
            }
          >
            <IdentityImage
              className={styles.avatar ?? ""}
              fallback={initials(name)}
              source="/api/account/avatar"
            />
            <span className="or-visually-hidden">
              {completion}% {c.profileComplete}
            </span>
          </div>
          <div className={styles.identityCopy}>
            <h1>
              <bdi>{name}</bdi>
            </h1>
            <p>
              <bdi>{account.email}</bdi> · {tenant.tenantName}
            </p>
            <div className={styles.badges}>
              <span className={styles.successBadge}>
                <BadgeCheck aria-hidden="true" size={13} />
                {c.active}
              </span>
              <span className={styles.badge}>{c.roles[tenant.role]}</span>
              {account.isSuperuser ? (
                <span className={styles.badge}>{c.platformAdmin}</span>
              ) : null}
            </div>
          </div>
        </div>
        <div className={styles.heroActions}>
          <a
            className={styles.secondaryButton}
            href={`mailto:${account.email}`}
          >
            <Mail aria-hidden="true" size={15} />
            {c.email}
          </a>
          <Button onClick={() => setActiveTab("account")} size="small">
            <Pencil aria-hidden="true" size={15} />
            {c.edit}
          </Button>
        </div>
      </header>

      <div aria-label={c.profile} className={styles.tabs} role="group">
        {tabs.map((tab) => (
          <button
            aria-controls={`profile-panel-${tab.id}`}
            aria-pressed={activeTab === tab.id}
            id={`profile-tab-${tab.id}`}
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id);
              setFeedback(undefined);
            }}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section
        aria-labelledby={`profile-tab-${activeTab}`}
        className={styles.panel}
        id={`profile-panel-${activeTab}`}
      >
        {activeTab === "overview" ? (
          <div className={styles.overviewGrid}>
            <div className={styles.overviewMain}>
              <section className={styles.section}>
                <h2>{c.about}</h2>
                <p>{c.aboutBody}</p>
              </section>
              <section className={styles.section}>
                <h2>{c.workDetails}</h2>
                <dl className={styles.detailsGrid}>
                  <div>
                    <dt>{c.currentWorkspace}</dt>
                    <dd>{tenant.tenantName}</dd>
                  </div>
                  <div>
                    <dt>{c.accessRole}</dt>
                    <dd>{c.roles[tenant.role]}</dd>
                  </div>
                  <div>
                    <dt>{c.memberships}</dt>
                    <dd>{number.format(membershipCount)}</dd>
                  </div>
                  <div>
                    <dt>{c.signIn}</dt>
                    <dd>
                      <bdi>{account.email}</bdi>
                    </dd>
                  </div>
                </dl>
              </section>
            </div>
            <aside className={styles.statusCard}>
              <span className={styles.statusIcon}>
                <ShieldCheck aria-hidden="true" size={19} />
              </span>
              <div>
                <h2>{c.access}</h2>
                <p>{c.accessBody}</p>
              </div>
              <div className={styles.completion}>
                <span>
                  <Check aria-hidden="true" size={14} />
                  {completion}% {c.profileComplete}
                </span>
                <div>
                  <i style={{ inlineSize: `${String(completion)}%` }} />
                </div>
              </div>
              {completion < 100 ? <p>{c.profileNeedsName}</p> : null}
            </aside>
          </div>
        ) : null}

        {activeTab === "account" ? (
          <div className={styles.formLayout}>
            <div className={styles.formIntro}>
              <span>
                <UserRound aria-hidden="true" size={18} />
              </span>
              <div>
                <h2>{c.personalTitle}</h2>
                <p>{c.personalHint}</p>
              </div>
            </div>
            <form
              className={styles.formCard}
              onSubmit={(event) => void saveProfile(event)}
            >
              <fieldset disabled={pending}>
                <IdentityImageEditor
                  chooseLabel={c.uploadPhoto}
                  failedLabel={c.photoFailed}
                  fallback={initials(name)}
                  hint={c.photoHint}
                  removeLabel={c.removePhoto}
                  removedLabel={c.photoRemoved}
                  source="/api/account/avatar"
                  title={c.photoTitle}
                  updatedLabel={c.photoUpdated}
                />
                <Input
                  defaultValue={account.displayName ?? ""}
                  id="profile-display-name"
                  label={c.displayName}
                  maxLength={120}
                  name="displayName"
                />
                <Input
                  autoComplete="email"
                  defaultValue={account.email}
                  id="profile-email"
                  label={c.emailAddress}
                  name="email"
                  required
                  type="email"
                />
                <Input
                  autoComplete="current-password"
                  id="profile-email-password"
                  label={c.currentPasswordEmail}
                  name="currentPassword"
                  type="password"
                />
                {feedback ? (
                  <p
                    className={
                      feedback.tone === "error" ? styles.error : styles.success
                    }
                    role={feedback.tone === "error" ? "alert" : "status"}
                  >
                    {feedback.text}
                  </p>
                ) : null}
                <div className={styles.formActions}>
                  <Button busy={pending} type="submit">
                    {c.save}
                  </Button>
                </div>
              </fieldset>
            </form>
          </div>
        ) : null}

        {activeTab === "security" ? (
          <div className={styles.formLayout}>
            <div className={styles.formIntro}>
              <span>
                <KeyRound aria-hidden="true" size={18} />
              </span>
              <div>
                <h2>{c.passwordTitle}</h2>
                <p>{c.passwordHint}</p>
              </div>
            </div>
            <form
              className={styles.formCard}
              onSubmit={(event) => void savePassword(event)}
            >
              <fieldset disabled={pending}>
                <Input
                  autoComplete="current-password"
                  id="profile-password-current"
                  label={c.currentPassword}
                  name="currentPassword"
                  required
                  type="password"
                />
                <Input
                  autoComplete="new-password"
                  id="profile-password-new"
                  label={c.newPassword}
                  minLength={12}
                  name="newPassword"
                  required
                  type="password"
                />
                <Input
                  autoComplete="new-password"
                  id="profile-password-confirm"
                  label={c.confirmPassword}
                  minLength={12}
                  name="confirmPassword"
                  required
                  type="password"
                />
                {feedback ? (
                  <p
                    className={
                      feedback.tone === "error" ? styles.error : styles.success
                    }
                    role={feedback.tone === "error" ? "alert" : "status"}
                  >
                    {feedback.text}
                  </p>
                ) : null}
                <div className={styles.formActions}>
                  <Button busy={pending} type="submit">
                    <LockKeyhole aria-hidden="true" size={15} />
                    {c.changePassword}
                  </Button>
                </div>
              </fieldset>
            </form>
          </div>
        ) : null}

        {activeTab === "appearance" ? (
          <div className={styles.formLayout}>
            <div className={styles.formIntro}>
              <span>
                <Globe2 aria-hidden="true" size={18} />
              </span>
              <div>
                <h2>{c.preferences}</h2>
                <p>{c.preferencesHint}</p>
              </div>
            </div>
            <div className={styles.preferenceCard}>
              <div className={styles.preferenceRow}>
                <div>
                  <h3>{c.language}</h3>
                  <p>{c.languageHint}</p>
                </div>
                <LanguageControl />
              </div>
              <div className={styles.preferenceRow}>
                <div>
                  <h3>{c.theme}</h3>
                  <p>{c.themeHint}</p>
                </div>
                <ThemeControl />
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
