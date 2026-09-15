"use client";

import type { TeamMember, TenantInvitationSummary } from "@or-on/crm";
import {
  AnimatedNumber,
  Button,
  ConfirmDialog,
  Dialog,
  Input,
  Select,
  Surface,
} from "@or-on/ui";
import {
  Clock3,
  Copy,
  Mail,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { useLocale, useTimeZone } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type SyntheticEvent } from "react";

import { crmMutation } from "../crm";
import styles from "./users-workspace.module.css";

type UserView = "members" | "invitations";
type UserRoleFilter = TeamMember["role"] | "all";

const copy = {
  en: {
    title: "Users",
    description: "Manage workspace members, roles, and pending invitations.",
    eyebrow: "Workspace access",
    totalMembers: "Total members",
    administrators: "Administrators",
    agents: "Agents",
    pendingInvitations: "Pending invitations",
    members: "Members",
    invitations: "Invitations",
    invite: "Invite user",
    search: "Search users…",
    filterRole: "Filter by role",
    allRoles: "All roles",
    person: "User",
    role: "Role",
    access: "Access",
    actions: "Actions",
    active: "Active",
    current: "You",
    noMembers: "No members match this search.",
    noInvitations: "No pending invitations.",
    pending: "Pending",
    expires: "Expires",
    invited: "Invited",
    inviteTitle: "Invite a teammate",
    inviteDescription:
      "Create a secure, single-use invitation link. Email delivery is not configured, so share the link through a trusted channel.",
    email: "Email address",
    createInvite: "Create invitation",
    close: "Close",
    copyLink: "Copy invitation link",
    copied: "Invitation link copied.",
    copyFailed: "The link could not be copied.",
    invitedSuccess: "Invitation created. Copy this link now.",
    invitationRevoked: "Invitation revoked.",
    revokeInvitation: "Revoke invitation",
    revokeInvitationTitle: "Revoke this invitation?",
    revokeInvitationDescription:
      "The invitation link will stop working immediately. The recipient will need a new invitation to join this workspace.",
    confirmRevokeInvitation: "Revoke invitation",
    roleSaved: "Role updated.",
    removed: "Member removed.",
    remove: "Remove user",
    removeTitle: "Remove workspace access?",
    removeDescription:
      "This user will immediately lose access to this workspace. Their account and other workspace memberships are unchanged.",
    cancel: "Cancel",
    confirmRemove: "Remove access",
    failed: "The change could not be completed. Please try again.",
    count: "users",
    tableRegion: "Scrollable workspace users",
    roles: {
      owner: "Owner",
      admin: "Admin",
      agent: "Agent",
      technician: "Technician",
      viewer: "Viewer",
    },
  },
  he: {
    title: "משתמשים",
    description: "ניהול חברי סביבת העבודה, תפקידים והזמנות ממתינות.",
    eyebrow: "גישה לסביבת העבודה",
    totalMembers: "כל החברים",
    administrators: "מנהלים",
    agents: "נציגים",
    pendingInvitations: "הזמנות ממתינות",
    members: "חברים",
    invitations: "הזמנות",
    invite: "הזמנת משתמש",
    search: "חיפוש משתמשים…",
    filterRole: "סינון לפי תפקיד",
    allRoles: "כל התפקידים",
    person: "משתמש",
    role: "תפקיד",
    access: "גישה",
    actions: "פעולות",
    active: "פעיל",
    current: "אתם",
    noMembers: "לא נמצאו חברים התואמים לחיפוש.",
    noInvitations: "אין הזמנות ממתינות.",
    pending: "בהמתנה",
    expires: "תוקף עד",
    invited: "נוצרה",
    inviteTitle: "הזמנת חבר צוות",
    inviteDescription:
      "צרו קישור הזמנה מאובטח לשימוש חד-פעמי. שליחת אימייל אינה מוגדרת, לכן יש לשתף אותו בערוץ מהימן.",
    email: "כתובת אימייל",
    createInvite: "יצירת הזמנה",
    close: "סגירה",
    copyLink: "העתקת קישור ההזמנה",
    copied: "קישור ההזמנה הועתק.",
    copyFailed: "לא ניתן היה להעתיק את הקישור.",
    invitedSuccess: "ההזמנה נוצרה. העתיקו את הקישור כעת.",
    invitationRevoked: "ההזמנה בוטלה.",
    revokeInvitation: "ביטול הזמנה",
    revokeInvitationTitle: "לבטל את ההזמנה?",
    revokeInvitationDescription:
      "קישור ההזמנה יפסיק לפעול מיד. כדי להצטרף לסביבה יהיה צורך בהזמנה חדשה.",
    confirmRevokeInvitation: "ביטול ההזמנה",
    roleSaved: "התפקיד עודכן.",
    removed: "המשתמש הוסר.",
    remove: "הסרת משתמש",
    removeTitle: "להסיר גישה לסביבת העבודה?",
    removeDescription:
      "המשתמש יאבד מיד את הגישה לסביבה זו. החשבון וחברויות בסביבות אחרות לא ישתנו.",
    cancel: "ביטול",
    confirmRemove: "הסרת גישה",
    failed: "לא ניתן היה להשלים את השינוי. נסו שוב.",
    count: "משתמשים",
    tableRegion: "טבלת משתמשי סביבת העבודה הניתנת לגלילה",
    roles: {
      owner: "בעלים",
      admin: "מנהל",
      agent: "נציג",
      technician: "טכנאי",
      viewer: "צופה",
    },
  },
} as const;

function initials(member: TeamMember): string {
  const candidate = member.displayName?.trim();
  const value =
    candidate === undefined || candidate === "" ? member.email : candidate;
  const parts = value.split(/\s+/u).filter(Boolean);
  return (
    parts.length > 1
      ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`
      : value.slice(0, 2)
  ).toUpperCase();
}

export function UsersWorkspace({
  members,
  invitations,
  currentUserId,
  canManageOwners,
  initialRole = "all",
}: {
  readonly members: readonly TeamMember[];
  readonly invitations: readonly TenantInvitationSummary[];
  readonly currentUserId: string;
  readonly canManageOwners: boolean;
  readonly initialRole?: UserRoleFilter;
}) {
  const locale = useLocale();
  const timeZone = useTimeZone();
  const c = locale.startsWith("he") ? copy.he : copy.en;
  const router = useRouter();
  const [view, setView] = useState<UserView>("members");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<UserRoleFilter>(initialRole);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invitationLink, setInvitationLink] = useState<string>();
  const [currentInvitations, setCurrentInvitations] = useState(invitations);
  const [revokeTarget, setRevokeTarget] = useState<TenantInvitationSummary>();
  const [removeTarget, setRemoveTarget] = useState<TeamMember>();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    readonly tone: "error" | "success";
    readonly text: string;
  }>();
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeZone: timeZone ?? "UTC",
      }),
    [locale, timeZone],
  );
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  useEffect(() => setCurrentInvitations(invitations), [invitations]);
  const visibleMembers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    return members.filter(
      (member) =>
        (role === "all" || member.role === role) &&
        (normalized === "" ||
          `${member.displayName ?? ""} ${member.email} ${member.role}`
            .toLocaleLowerCase(locale)
            .includes(normalized)),
    );
  }, [locale, members, query, role]);
  const visibleInvitations = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    return currentInvitations.filter(
      (invitation) =>
        (role === "all" || invitation.role === role) &&
        (normalized === "" ||
          `${invitation.email} ${invitation.role}`
            .toLocaleLowerCase(locale)
            .includes(normalized)),
    );
  }, [currentInvitations, locale, query, role]);
  const administratorCount = members.filter(
    (member) => member.role === "owner" || member.role === "admin",
  ).length;
  const agentCount = members.filter((member) => member.role === "agent").length;

  async function createInvitation(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setFeedback(undefined);
    try {
      const result = await crmMutation<{ readonly token: string }>(
        "/api/settings/invitations",
        { email: data.get("email"), role: data.get("role") },
      );
      setInvitationLink(
        `${window.location.origin}/invite?token=${encodeURIComponent(result.token)}`,
      );
      setFeedback({ tone: "success", text: c.invitedSuccess });
      form.reset();
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

  async function changeRole(member: TeamMember, nextRole: TeamMember["role"]) {
    setPending(true);
    setFeedback(undefined);
    try {
      await crmMutation(
        `/api/settings/members/${member.userId}`,
        { role: nextRole },
        { method: "PATCH" },
      );
      setFeedback({ tone: "success", text: c.roleSaved });
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

  async function removeMember() {
    if (removeTarget === undefined) return;
    setPending(true);
    setFeedback(undefined);
    try {
      await crmMutation(
        `/api/settings/members/${removeTarget.userId}`,
        {},
        { method: "DELETE" },
      );
      setRemoveTarget(undefined);
      setFeedback({ tone: "success", text: c.removed });
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

  async function revokeInvitation() {
    if (revokeTarget === undefined) return;
    setPending(true);
    setFeedback(undefined);
    try {
      await crmMutation(
        `/api/settings/invitations/${revokeTarget.id}`,
        {},
        { method: "DELETE" },
      );
      setCurrentInvitations((records) =>
        records.filter((invitation) => invitation.id !== revokeTarget.id),
      );
      setRevokeTarget(undefined);
      setFeedback({ tone: "success", text: c.invitationRevoked });
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

  async function copyInvitation() {
    if (invitationLink === undefined) return;
    try {
      await navigator.clipboard.writeText(invitationLink);
      setFeedback({ tone: "success", text: c.copied });
    } catch {
      setFeedback({ tone: "error", text: c.copyFailed });
    }
  }

  return (
    <div className={["platform-admin-workspace", styles.workspace].join(" ")}>
      <header className="platform-admin-hero">
        <div className="platform-admin-hero__copy">
          <span className="eyebrow">{c.eyebrow}</span>
          <h1>{c.title}</h1>
          <p>{c.description}</p>
        </div>
        <Button
          className="platform-admin-hero__action"
          onClick={() => {
            setInvitationLink(undefined);
            setFeedback(undefined);
            setInviteOpen(true);
          }}
          size="small"
        >
          <UserPlus aria-hidden="true" size={15} />
          {c.invite}
        </Button>
      </header>

      <section aria-label={c.title} className="platform-admin-summary">
        <Surface as="article">
          <span className="platform-admin-summary__icon">
            <UsersRound aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{c.totalMembers}</small>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={members.length}
              />
            </strong>
          </span>
        </Surface>
        <Surface as="article">
          <span className="platform-admin-summary__icon" data-tone="positive">
            <ShieldCheck aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{c.administrators}</small>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={administratorCount}
              />
            </strong>
          </span>
        </Surface>
        <Surface as="article">
          <span className="platform-admin-summary__icon">
            <UserCheck aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{c.agents}</small>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={agentCount}
              />
            </strong>
          </span>
        </Surface>
        <Surface as="article">
          <span className="platform-admin-summary__icon" data-tone="warning">
            <Mail aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{c.pendingInvitations}</small>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={currentInvitations.length}
              />
            </strong>
          </span>
        </Surface>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div aria-label={c.title} className={styles.tabs} role="group">
            <button
              aria-pressed={view === "members"}
              onClick={() => setView("members")}
              type="button"
            >
              <UsersRound aria-hidden="true" size={14} />
              {c.members}
              <span>{number.format(members.length)}</span>
            </button>
            <button
              aria-pressed={view === "invitations"}
              onClick={() => setView("invitations")}
              type="button"
            >
              <Mail aria-hidden="true" size={14} />
              {c.invitations}
              <span>{number.format(currentInvitations.length)}</span>
            </button>
          </div>
          <div className={styles.filters}>
            <label className={styles.search}>
              <Search aria-hidden="true" size={14} />
              <span className="or-visually-hidden">{c.search}</span>
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder={c.search}
                type="search"
                value={query}
              />
            </label>
            <label>
              <span className="or-visually-hidden">{c.filterRole}</span>
              <select
                aria-label={c.filterRole}
                onChange={(event) =>
                  setRole(event.target.value as UserRoleFilter)
                }
                value={role}
              >
                <option value="all">{c.allRoles}</option>
                <option value="owner">{c.roles.owner}</option>
                <option value="admin">{c.roles.admin}</option>
                <option value="agent">{c.roles.agent}</option>
                <option value="technician">{c.roles.technician}</option>
                <option value="viewer">{c.roles.viewer}</option>
              </select>
            </label>
          </div>
        </div>

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

        {view === "members" ? (
          visibleMembers.length === 0 ? (
            <div className={styles.empty}>
              <UsersRound aria-hidden="true" size={22} />
              <p>{c.noMembers}</p>
            </div>
          ) : (
            <div
              aria-label={c.tableRegion}
              className={styles.tableWrap}
              role="region"
              tabIndex={0}
            >
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{c.person}</th>
                    <th scope="col">{c.role}</th>
                    <th scope="col">{c.access}</th>
                    <th scope="col">
                      <span className="or-visually-hidden">{c.actions}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMembers.map((member) => {
                    const ownerProtected =
                      member.role === "owner" && !canManageOwners;
                    const removable =
                      !ownerProtected && member.userId !== currentUserId;
                    return (
                      <tr key={member.userId}>
                        <td data-label={c.person}>
                          <div className={styles.person}>
                            <span className={styles.avatar} aria-hidden="true">
                              {initials(member)}
                            </span>
                            <div>
                              <strong>
                                {member.displayName ?? member.email}
                              </strong>
                              <small>
                                <bdi>{member.email}</bdi>
                                {member.userId === currentUserId
                                  ? ` · ${c.current}`
                                  : ""}
                              </small>
                            </div>
                          </div>
                        </td>
                        <td data-label={c.role}>
                          {ownerProtected ? (
                            <span className={styles.roleBadge}>
                              <ShieldCheck aria-hidden="true" size={12} />
                              {c.roles[member.role]}
                            </span>
                          ) : (
                            <select
                              aria-label={`${c.role}: ${member.email}`}
                              disabled={pending}
                              onChange={(event) =>
                                void changeRole(
                                  member,
                                  event.target.value as TeamMember["role"],
                                )
                              }
                              value={member.role}
                            >
                              {canManageOwners ? (
                                <option value="owner">{c.roles.owner}</option>
                              ) : null}
                              <option value="admin">{c.roles.admin}</option>
                              <option value="agent">{c.roles.agent}</option>
                              <option value="technician">
                                {c.roles.technician}
                              </option>
                              <option value="viewer">{c.roles.viewer}</option>
                            </select>
                          )}
                        </td>
                        <td data-label={c.access}>
                          <span className={styles.status}>
                            <i />
                            {c.active}
                          </span>
                        </td>
                        <td className={styles.actionCell}>
                          {removable ? (
                            <button
                              aria-label={`${c.remove}: ${member.email}`}
                              className={styles.iconButton}
                              disabled={pending}
                              onClick={() => setRemoveTarget(member)}
                              type="button"
                            >
                              <Trash2 aria-hidden="true" size={15} />
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : visibleInvitations.length === 0 ? (
          <div className={styles.empty}>
            <Clock3 aria-hidden="true" size={22} />
            <p>{c.noInvitations}</p>
          </div>
        ) : (
          <div className={styles.invitationList}>
            {visibleInvitations.map((invitation) => (
              <article key={invitation.id}>
                <span className={styles.avatar} aria-hidden="true">
                  <Mail size={14} />
                </span>
                <div>
                  <strong>
                    <bdi>{invitation.email}</bdi>
                  </strong>
                  <small>
                    {c.invited}:{" "}
                    <time dateTime={invitation.createdAt}>
                      {formatter.format(new Date(invitation.createdAt))}
                    </time>
                  </small>
                </div>
                <span className={styles.roleBadge}>
                  {c.roles[invitation.role]}
                </span>
                <span className={styles.pendingBadge}>{c.pending}</span>
                <time dateTime={invitation.expiresAt}>
                  {c.expires}:{" "}
                  {formatter.format(new Date(invitation.expiresAt))}
                </time>
                <button
                  aria-label={`${c.revokeInvitation}: ${invitation.email}`}
                  className={styles.iconButton}
                  disabled={pending}
                  onClick={() => setRevokeTarget(invitation)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      <Dialog
        className={styles.dialog ?? ""}
        closeLabel={c.close}
        description={c.inviteDescription}
        onClose={() => {
          if (!pending) setInviteOpen(false);
        }}
        open={inviteOpen}
        title={c.inviteTitle}
      >
        <form
          className={styles.inviteForm}
          onSubmit={(event) => void createInvitation(event)}
        >
          <fieldset disabled={pending}>
            <Input
              data-dialog-initial-focus
              id="user-invitation-email"
              label={c.email}
              name="email"
              required
              type="email"
            />
            <Select
              defaultValue="agent"
              id="user-invitation-role"
              label={c.role}
              name="role"
            >
              <option value="admin">{c.roles.admin}</option>
              <option value="agent">{c.roles.agent}</option>
              <option value="technician">{c.roles.technician}</option>
              <option value="viewer">{c.roles.viewer}</option>
            </Select>
            <Button busy={pending} type="submit">
              <UserPlus aria-hidden="true" size={15} />
              {c.createInvite}
            </Button>
          </fieldset>
        </form>
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
        {invitationLink ? (
          <div className={styles.invitationLink}>
            <code dir="ltr">{invitationLink}</code>
            <Button
              onClick={() => void copyInvitation()}
              size="small"
              variant="secondary"
            >
              <Copy aria-hidden="true" size={14} />
              {c.copyLink}
            </Button>
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        busy={pending}
        cancelLabel={c.cancel}
        confirmLabel={c.confirmRemove}
        destructive
        description={c.removeDescription}
        onCancel={() => {
          if (!pending) setRemoveTarget(undefined);
        }}
        onConfirm={() => void removeMember()}
        open={removeTarget !== undefined}
        title={c.removeTitle}
      />
      <ConfirmDialog
        busy={pending}
        cancelLabel={c.cancel}
        confirmLabel={c.confirmRevokeInvitation}
        destructive
        description={c.revokeInvitationDescription}
        onCancel={() => {
          if (!pending) setRevokeTarget(undefined);
        }}
        onConfirm={() => void revokeInvitation()}
        open={revokeTarget !== undefined}
        title={c.revokeInvitationTitle}
      />
    </div>
  );
}
