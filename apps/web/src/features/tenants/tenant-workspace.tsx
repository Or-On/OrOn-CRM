"use client";

import type { PlatformTenantSummary } from "@or-on/crm";
import {
  AnimatedNumber,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Select,
  Surface,
} from "@or-on/ui";
import {
  Building2,
  CircleCheckBig,
  Globe2,
  Plus,
  Trash2,
  Users,
  WalletCards,
} from "lucide-react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, type SyntheticEvent } from "react";
import { crmMutation } from "../crm";

export function TenantWorkspace({
  currentTenantId,
  tenants,
}: {
  readonly currentTenantId: string;
  readonly tenants: readonly PlatformTenantSummary[];
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [records, setRecords] = useState(tenants);
  const [deleteTarget, setDeleteTarget] = useState<PlatformTenantSummary>();
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  useEffect(() => setRecords(tenants), [tenants]);
  const activeTenants = records.filter(
    (tenant) => tenant.status === "active",
  ).length;
  const members = records.reduce(
    (total, tenant) => total + tenant.memberCount,
    0,
  );
  const currencies = new Set(records.map((tenant) => tenant.defaultCurrency))
    .size;
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);
    try {
      await crmMutation("/api/tenants", Object.fromEntries(form.entries()));
      setOpen(false);
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Tenant could not be created",
      );
    } finally {
      setPending(false);
    }
  }
  async function deleteTenant() {
    if (deleteTarget === undefined) return;
    setDeletePending(true);
    setDeleteError(undefined);
    try {
      await crmMutation(
        `/api/tenants/${deleteTarget.id}`,
        {},
        { method: "DELETE" },
      );
      setRecords((current) =>
        current.filter((tenant) => tenant.id !== deleteTarget.id),
      );
      setDeleteTarget(undefined);
      setDeleteConfirmation("");
      router.refresh();
    } catch (reason) {
      setDeleteError(
        reason instanceof Error
          ? reason.message
          : he
            ? "לא ניתן היה למחוק את סביבת העבודה"
            : "Tenant could not be deleted",
      );
    } finally {
      setDeletePending(false);
    }
  }
  return (
    <div className="tenant-admin-workspace">
      <header className="tenant-admin-hero">
        <div className="tenant-admin-hero__copy">
          <span className="eyebrow">
            {he ? "ניהול פלטפורמה" : "Platform administration"}
          </span>
          <h1>{he ? "סביבות עבודה" : "Tenants"}</h1>
          <p>
            {he
              ? "יצירת סביבת עבודה מלאה עם כל המודולים, ארנק והגדרות ברירת מחדל."
              : "Create complete workspaces with every product module, a campaign wallet, and secure defaults."}
          </p>
        </div>
        <Button
          className="tenant-admin-hero__action"
          onClick={() => setOpen(true)}
        >
          <Plus size={16} />
          {he ? "דייר חדש" : "New tenant"}
        </Button>
      </header>
      <section
        aria-label={he ? "סקירת סביבות עבודה" : "Tenant overview"}
        className="tenant-admin-summary"
      >
        <Surface as="article">
          <span className="tenant-admin-summary__icon">
            <Building2 aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{he ? "סביבות עבודה" : "Total tenants"}</small>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={records.length}
              />
            </strong>
          </span>
        </Surface>
        <Surface as="article">
          <span className="tenant-admin-summary__icon" data-tone="positive">
            <CircleCheckBig aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{he ? "פעילות" : "Active"}</small>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={activeTenants}
              />
            </strong>
          </span>
        </Surface>
        <Surface as="article">
          <span className="tenant-admin-summary__icon">
            <Users aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{he ? "משתמשים" : "Members"}</small>
            <strong>
              <AnimatedNumber animateOnMount locale={locale} value={members} />
            </strong>
          </span>
        </Surface>
        <Surface as="article">
          <span className="tenant-admin-summary__icon">
            <Globe2 aria-hidden="true" size={19} />
          </span>
          <span>
            <small>{he ? "מטבעות" : "Currencies"}</small>
            <strong>
              <AnimatedNumber
                animateOnMount
                locale={locale}
                value={currencies}
              />
            </strong>
          </span>
        </Surface>
      </section>
      {records.length === 0 ? (
        <Surface className="tenant-admin-empty" level="raised">
          <EmptyState
            action={
              <Button onClick={() => setOpen(true)}>
                <Plus size={16} />
                {he ? "יצירת דייר" : "Create tenant"}
              </Button>
            }
            description={
              he
                ? "צור את סביבת העבודה הראשונה עם תפקידים, כספים וארנק קמפיינים מוכנים."
                : "Create the first workspace with roles, finance defaults, and a campaign wallet ready to use."
            }
            title={he ? "אין עדיין סביבות עבודה" : "No tenants yet"}
          />
        </Surface>
      ) : (
        <section
          className="tenant-admin-directory"
          aria-labelledby="tenant-directory-title"
        >
          <header>
            <div>
              <span className="eyebrow">
                {he ? "ספריית סביבות עבודה" : "Workspace directory"}
              </span>
              <h2 id="tenant-directory-title">
                {he ? "כל סביבות העבודה" : "All tenants"}
              </h2>
              <p>
                {he
                  ? "סביבות עבודה מבודדות, חברי צוות והגדרות אזוריות במקום אחד."
                  : "Isolated workspaces, membership totals, and regional defaults in one place."}
              </p>
            </div>
            <Badge
              label={
                he
                  ? `${String(records.length)} סביבות`
                  : `${String(records.length)} ${records.length === 1 ? "tenant" : "tenants"}`
              }
              tone="neutral"
            />
          </header>
          <div className="tenant-admin-grid">
            {records.map((tenant) => (
              <Surface as="article" key={tenant.id} level="raised">
                <div className="tenant-admin-card__heading">
                  <span className="tenant-admin-icon">
                    <Building2 aria-hidden="true" size={19} />
                  </span>
                  <div>
                    <h3>{tenant.name}</h3>
                    <p>/{tenant.slug}</p>
                  </div>
                  <div className="tenant-admin-card__actions">
                    <Badge
                      label={
                        tenant.status === "active"
                          ? he
                            ? "פעילה"
                            : "Active"
                          : tenant.status
                      }
                      tone={tenant.status === "active" ? "positive" : "neutral"}
                    />
                    <IconButton
                      disabled={
                        tenant.id === currentTenantId || records.length <= 1
                      }
                      label={
                        tenant.id === currentTenantId
                          ? he
                            ? "יש לעבור לסביבה אחרת לפני המחיקה"
                            : "Switch to another tenant before deleting this one"
                          : records.length <= 1
                            ? he
                              ? "לא ניתן למחוק את הסביבה הפעילה האחרונה"
                              : "The final active tenant cannot be deleted"
                            : he
                              ? `מחיקת ${tenant.name}`
                              : `Delete ${tenant.name}`
                      }
                      onClick={() => {
                        setDeleteTarget(tenant);
                        setDeleteConfirmation("");
                        setDeleteError(undefined);
                      }}
                      variant="danger"
                    >
                      <Trash2 aria-hidden="true" size={15} />
                    </IconButton>
                  </div>
                </div>
                <dl>
                  <div>
                    <dt>
                      <Users aria-hidden="true" size={14} />
                      {he ? "משתמשים" : "Members"}
                    </dt>
                    <dd>{tenant.memberCount}</dd>
                  </div>
                  <div>
                    <dt>
                      <WalletCards aria-hidden="true" size={14} />
                      {he ? "מטבע" : "Currency"}
                    </dt>
                    <dd>{tenant.defaultCurrency}</dd>
                  </div>
                  <div>
                    <dt>
                      <Globe2 aria-hidden="true" size={14} />
                      {he ? "אזור זמן" : "Timezone"}
                    </dt>
                    <dd>{tenant.timezone}</dd>
                  </div>
                </dl>
              </Surface>
            ))}
          </div>
        </section>
      )}
      <Dialog
        closeLabel={he ? "סגירה" : "Close"}
        open={open}
        onClose={() => setOpen(false)}
        title={he ? "יצירת דייר" : "Create tenant"}
      >
        <form
          className="tenant-admin-form"
          onSubmit={(event) => void submit(event)}
        >
          <Input
            id="tenant-name"
            label={he ? "שם" : "Tenant name"}
            name="name"
            required
          />
          <Input
            id="tenant-slug"
            label={he ? "מזהה כתובת" : "URL slug"}
            name="slug"
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            required
          />
          <Input
            id="tenant-owner"
            label={
              he
                ? "אימייל בעלים קיים (אופציונלי)"
                : "Existing owner email (optional)"
            }
            name="ownerEmail"
            type="email"
          />
          <Input
            id="tenant-currency"
            defaultValue="USD"
            label={he ? "מטבע" : "Currency"}
            maxLength={3}
            name="currency"
            required
          />
          <Select
            id="tenant-locale"
            label={he ? "שפה" : "Locale"}
            name="locale"
            defaultValue="en"
          >
            <option value="en">English</option>
            <option value="he">עברית</option>
          </Select>
          <Input
            id="tenant-timezone"
            defaultValue="Asia/Jerusalem"
            label={he ? "אזור זמן" : "Timezone"}
            name="timezone"
            required
          />
          <p>
            {he
              ? "כל המודולים הנוכחיים, ההרשאות, הגדרות הכספים וארנק קמפיינים ייווצרו אוטומטית."
              : "All current modules, permission roles, finance defaults, and the campaign wallet are included automatically."}
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <Button disabled={pending} type="submit">
            {pending
              ? he
                ? "יוצר…"
                : "Creating…"
              : he
                ? "יצירת דייר"
                : "Create tenant"}
          </Button>
        </form>
      </Dialog>
      <ConfirmDialog
        busy={deletePending}
        cancelLabel={he ? "ביטול" : "Cancel"}
        confirmDisabled={
          deleteTarget?.slug !== deleteConfirmation.trim().toLowerCase()
        }
        confirmLabel={he ? "מחיקת סביבת העבודה" : "Delete tenant"}
        destructive
        {...(deleteTarget === undefined
          ? {}
          : {
              description: he
                ? `הגישה לסביבה ${deleteTarget.name} תבוטל, עבודות ממתינות ייעצרו והנתונים יישמרו לצורכי ביקורת ושחזור.`
                : `Access to ${deleteTarget.name} will be disabled, queued work will stop, and its data will be retained for audit and recovery.`,
            })}
        onCancel={() => {
          if (deletePending) return;
          setDeleteTarget(undefined);
          setDeleteConfirmation("");
          setDeleteError(undefined);
        }}
        onConfirm={() => void deleteTenant()}
        open={deleteTarget !== undefined}
        title={he ? "מחיקת סביבת עבודה?" : "Delete this tenant?"}
      >
        {deleteTarget === undefined ? null : (
          <div className="tenant-admin-delete-confirmation">
            <p>
              {he
                ? `כדי לאשר, יש להקליד ${deleteTarget.slug}.`
                : `Type ${deleteTarget.slug} to confirm.`}
            </p>
            <Input
              autoComplete="off"
              id="tenant-delete-confirmation"
              label={he ? "מזהה סביבת העבודה" : "Tenant URL slug"}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              value={deleteConfirmation}
            />
            {deleteError === undefined ? null : (
              <p role="alert">{deleteError}</p>
            )}
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
