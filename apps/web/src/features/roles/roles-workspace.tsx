"use client";

import { AnimatedNumber, Surface } from "@or-on/ui";
import {
  Check,
  KeyRound,
  Search,
  ShieldCheck,
  ShieldEllipsis,
  UsersRound,
} from "lucide-react";
import { useLocale } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";

import styles from "./roles-workspace.module.css";

type RoleName = "owner" | "admin" | "agent" | "viewer";
type RoleView = "roles" | "matrix";

export interface RoleRecord {
  readonly name: RoleName;
  readonly memberCount: number;
  readonly permissions: readonly string[];
}

const copy = {
  en: {
    title: "Roles & Permissions",
    description: "Review the access model enforced across this workspace.",
    eyebrow: "Authorization model",
    roleCount: "Built-in roles",
    memberCount: "Assigned members",
    permissionCount: "Permissions",
    broadCount: "Broad-access roles",
    roles: "Roles",
    matrix: "Permission matrix",
    noticeTitle: "Enforced built-in access model",
    notice:
      "These built-in roles are the platform's active access model. Server authorization enforces their permissions, while PostgreSQL row-level security isolates tenant data. Use Users to assign or change each member's role.",
    manageUsers: "Manage role assignments",
    search: "Search roles…",
    filter: "Filter by access level",
    all: "All access levels",
    broad: "Broad access",
    operational: "Operational",
    readOnly: "Read only",
    role: "Role",
    people: "Users",
    level: "Access level",
    permissions: "Permissions",
    system: "System",
    noRoles: "No roles match this search.",
    matrixHint: "A check means the role receives that permission.",
    permission: "Permission",
    members: "members",
    rolesRegion: "Scrollable roles table",
    matrixRegion: "Scrollable permission matrix",
    granted: "Granted",
    denied: "Denied",
    descriptions: {
      owner:
        "Full workspace ownership, member administration, and every product capability.",
      admin:
        "Workspace administration and operations without ownership-only authority.",
      agent: "Daily customer operations, messaging, voice, CRM, and pipelines.",
      viewer:
        "Read-only visibility into the platform, CRM, and voice activity.",
    },
    levels: {
      owner: "Full control",
      admin: "Administration",
      agent: "Operations",
      viewer: "Read only",
    },
    roleLabels: {
      owner: "Owner",
      admin: "Admin",
      agent: "Agent",
      viewer: "Viewer",
    },
  },
  he: {
    title: "תפקידים והרשאות",
    description: "סקירת מודל הגישה שנאכף בכל סביבת העבודה.",
    eyebrow: "מודל הרשאות",
    roleCount: "תפקידים מובנים",
    memberCount: "חברים משויכים",
    permissionCount: "הרשאות",
    broadCount: "תפקידים בגישה רחבה",
    roles: "תפקידים",
    matrix: "מטריצת הרשאות",
    noticeTitle: "מודל גישה מובנה ונאכף",
    notice:
      "התפקידים המובנים הם מודל הגישה הפעיל של הפלטפורמה. הרשאות השרת אוכפות אותם ואבטחת השורות של PostgreSQL מבודדת את נתוני סביבת העבודה. במסך המשתמשים ניתן להקצות תפקיד לכל חבר או לשנותו.",
    manageUsers: "ניהול הקצאות תפקידים",
    search: "חיפוש תפקידים…",
    filter: "סינון לפי רמת גישה",
    all: "כל רמות הגישה",
    broad: "גישה רחבה",
    operational: "תפעולית",
    readOnly: "קריאה בלבד",
    role: "תפקיד",
    people: "משתמשים",
    level: "רמת גישה",
    permissions: "הרשאות",
    system: "מערכת",
    noRoles: "לא נמצאו תפקידים התואמים לחיפוש.",
    matrixHint: "סימון מציין שהתפקיד מקבל את ההרשאה.",
    permission: "הרשאה",
    members: "חברים",
    rolesRegion: "טבלת תפקידים הניתנת לגלילה",
    matrixRegion: "מטריצת הרשאות הניתנת לגלילה",
    granted: "מורשה",
    denied: "לא מורשה",
    descriptions: {
      owner: "בעלות מלאה על סביבת העבודה, ניהול חברים וכל יכולות המוצר.",
      admin: "ניהול סביבת העבודה והתפעול ללא סמכויות השמורות לבעלים.",
      agent: "תפעול לקוחות יומיומי, הודעות, קול, CRM וצינורות מכירה.",
      viewer: "צפייה בלבד בפלטפורמה, ב-CRM ובפעילות הקולית.",
    },
    levels: {
      owner: "שליטה מלאה",
      admin: "ניהול",
      agent: "תפעול",
      viewer: "קריאה בלבד",
    },
    roleLabels: {
      owner: "בעלים",
      admin: "מנהל",
      agent: "נציג",
      viewer: "צופה",
    },
  },
} as const;

function accessGroup(role: RoleName): "broad" | "operational" | "readOnly" {
  if (role === "owner" || role === "admin") return "broad";
  return role === "agent" ? "operational" : "readOnly";
}

export function RolesWorkspace({
  roles,
  allPermissions,
}: {
  readonly roles: readonly RoleRecord[];
  readonly allPermissions: readonly string[];
}) {
  const locale = useLocale();
  const c = locale.startsWith("he") ? copy.he : copy.en;
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const [view, setView] = useState<RoleView>("roles");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const visibleRoles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    return roles.filter((role) => {
      const matchesGroup = group === "all" || accessGroup(role.name) === group;
      const searchable =
        `${role.name} ${c.descriptions[role.name]} ${role.permissions.join(" ")}`.toLocaleLowerCase(
          locale,
        );
      return (
        matchesGroup && (normalized === "" || searchable.includes(normalized))
      );
    });
  }, [c.descriptions, group, locale, query, roles]);
  const memberCount = roles.reduce(
    (total, role) => total + role.memberCount,
    0,
  );
  const broadCount = roles.filter(
    (role) => accessGroup(role.name) === "broad",
  ).length;

  return (
    <div className={["platform-admin-workspace", styles.workspace].join(" ")}>
      <header className="platform-admin-hero">
        <div className="platform-admin-hero__copy">
          <span className="eyebrow">{c.eyebrow}</span>
          <h1>{c.title}</h1>
          <p>{c.description}</p>
        </div>
        <Link
          className="or-button or-button--primary or-button--medium platform-admin-hero__action"
          href="/users"
        >
          <UsersRound aria-hidden="true" size={15} />
          {c.manageUsers}
        </Link>
      </header>

      <section aria-label={c.title} className="platform-admin-summary">
        <Surface as="article">
          <span className="platform-admin-summary__icon">
            <ShieldCheck aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{c.roleCount}</small>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={roles.length}
              />
            </strong>
          </span>
        </Surface>
        <Surface as="article">
          <span className="platform-admin-summary__icon" data-tone="positive">
            <UsersRound aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{c.memberCount}</small>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={memberCount}
              />
            </strong>
          </span>
        </Surface>
        <Surface as="article">
          <span className="platform-admin-summary__icon">
            <KeyRound aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{c.permissionCount}</small>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={allPermissions.length}
              />
            </strong>
          </span>
        </Surface>
        <Surface as="article">
          <span className="platform-admin-summary__icon" data-tone="warning">
            <ShieldEllipsis aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{c.broadCount}</small>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={broadCount}
              />
            </strong>
          </span>
        </Surface>
      </section>

      <div aria-label={c.title} className={styles.tabs} role="group">
        <button
          aria-pressed={view === "roles"}
          onClick={() => setView("roles")}
          type="button"
        >
          {c.roles}
        </button>
        <button
          aria-pressed={view === "matrix"}
          onClick={() => setView("matrix")}
          type="button"
        >
          {c.matrix}
        </button>
      </div>

      <aside className={styles.notice}>
        <ShieldCheck aria-hidden="true" size={17} />
        <div>
          <strong>{c.noticeTitle}</strong>
          <p>{c.notice}</p>
        </div>
      </aside>

      {view === "roles" ? (
        <section className={styles.card} aria-label={c.roles}>
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
              <span className="or-visually-hidden">{c.filter}</span>
              <select
                aria-label={c.filter}
                onChange={(event) => setGroup(event.target.value)}
                value={group}
              >
                <option value="all">{c.all}</option>
                <option value="broad">{c.broad}</option>
                <option value="operational">{c.operational}</option>
                <option value="readOnly">{c.readOnly}</option>
              </select>
            </label>
          </div>
          {visibleRoles.length === 0 ? (
            <div className={styles.empty}>
              <ShieldCheck aria-hidden="true" size={22} />
              <p>{c.noRoles}</p>
            </div>
          ) : (
            <div
              aria-label={c.rolesRegion}
              className={styles.tableWrap}
              role="region"
              tabIndex={0}
            >
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{c.role}</th>
                    <th scope="col">{c.people}</th>
                    <th scope="col">{c.level}</th>
                    <th scope="col">{c.permissions}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRoles.map((role) => (
                    <tr key={role.name}>
                      <td data-label={c.role}>
                        <div className={styles.roleIdentity}>
                          <span>
                            <ShieldCheck aria-hidden="true" size={15} />
                          </span>
                          <div>
                            <strong>{c.roleLabels[role.name]}</strong>
                            <small>{c.descriptions[role.name]}</small>
                          </div>
                        </div>
                      </td>
                      <td data-label={c.people}>
                        <Link
                          className={styles.memberLink}
                          href={`/users?role=${role.name}`}
                        >
                          {number.format(role.memberCount)} {c.members}
                        </Link>
                      </td>
                      <td data-label={c.level}>
                        <span className={styles.levelBadge}>
                          {c.levels[role.name]}
                        </span>
                      </td>
                      <td data-label={c.permissions}>
                        <div className={styles.permissionPreview}>
                          {role.permissions.slice(0, 3).map((permission) => (
                            <code key={permission}>{permission}</code>
                          ))}
                          {role.permissions.length > 3 ? (
                            <span>
                              +{number.format(role.permissions.length - 3)}
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <section className={styles.matrixCard} aria-label={c.matrix}>
          <header>
            <div>
              <h2>{c.matrix}</h2>
              <p>{c.matrixHint}</p>
            </div>
          </header>
          <div
            aria-label={c.matrixRegion}
            className={styles.matrixWrap}
            role="region"
            tabIndex={0}
          >
            <table className={styles.matrix}>
              <thead>
                <tr>
                  <th scope="col">{c.permission}</th>
                  {roles.map((role) => (
                    <th key={role.name} scope="col">
                      {c.roleLabels[role.name]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allPermissions.map((permission) => (
                  <tr key={permission}>
                    <th scope="row">
                      <code>{permission}</code>
                    </th>
                    {roles.map((role) => (
                      <td key={role.name}>
                        {role.permissions.includes(permission) ? (
                          <span
                            aria-label={`${c.roleLabels[role.name]}: ${permission}: ${c.granted}`}
                          >
                            <Check aria-hidden="true" size={14} />
                          </span>
                        ) : (
                          <>
                            <span className="or-visually-hidden">
                              {c.roleLabels[role.name]}: {permission}:{" "}
                              {c.denied}
                            </span>
                            <i aria-hidden="true">—</i>
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
