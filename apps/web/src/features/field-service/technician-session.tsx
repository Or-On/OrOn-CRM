"use client";

import type { SessionTechnician, TechnicianSessionCandidate } from "@or-on/crm";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  InlineFeedback,
  Input,
  Surface,
} from "@or-on/ui";
import { BadgeCheck, Repeat2, Search, UserRoundCheck } from "lucide-react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type SyntheticEvent } from "react";

import { crmMutation } from "../crm";
import { technicianIdentityLabel } from "./field-service-labels";

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toLocaleUpperCase())
    .join("");
}

/**
 * First step on a shared technician login: this browser session names the
 * physical technician using it. The choice binds only this session on the
 * server; other devices signed in to the same account keep their own.
 */
export function TechnicianIdentityGate({
  candidates,
}: {
  readonly candidates: readonly TechnicianSessionCandidate[];
}) {
  const he = useLocale().startsWith("he");
  const router = useRouter();
  const headingId = useId();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [employeeIdentifier, setEmployeeIdentifier] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const selected = candidates.find((candidate) => candidate.id === selectedId);
  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term === ""
      ? candidates
      : candidates.filter((candidate) =>
          candidate.fullName.toLocaleLowerCase().includes(term),
        );
  }, [candidates, query]);

  async function confirm(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected === undefined || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await crmMutation("/api/field-service/session-technician", {
        technicianId: selected.id,
        ...(selected.requiresEmployeeIdentifier
          ? { employeeIdentifier: employeeIdentifier.trim() }
          : {}),
      });
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : he
            ? "לא ניתן לאשר את הזהות. נסו שוב."
            : "Your identity could not be confirmed. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Surface
      aria-labelledby={headingId}
      className="technician-identity"
      level="raised"
    >
      <header className="technician-identity__header">
        <span aria-hidden="true" className="technician-identity__icon">
          <UserRoundCheck size={22} />
        </span>
        <div>
          <span className="eyebrow">
            {he ? "חשבון טכנאים משותף" : "Shared technician account"}
          </span>
          <h2 id={headingId}>
            {he ? "מי עובד במכשיר הזה?" : "Who is working on this device?"}
          </h2>
          <p>
            {he
              ? "בחרו את פרופיל הטכנאי שלכם. הבחירה חלה רק על המכשיר הזה — מכשירים אחרים המחוברים לאותו חשבון שומרים על הטכנאי שלהם."
              : "Choose your technician profile. It applies to this device only — other devices signed in to the same account keep their own technician."}
          </p>
        </div>
      </header>

      {candidates.length === 0 ? (
        <EmptyState
          title={
            he ? "אין פרופילי טכנאים זמינים" : "No technician profiles yet"
          }
          description={
            he
              ? "מנהל צריך להוסיף פרופילי טכנאים בשירות שטח ← טכנאים."
              : "A manager needs to add technician profiles in Field Service → Technicians."
          }
        />
      ) : (
        <form
          className="technician-identity__form"
          onSubmit={(event) => void confirm(event)}
        >
          {candidates.length > 6 ? (
            <div className="technician-identity__search">
              <Search aria-hidden="true" size={16} />
              <Input
                autoComplete="off"
                id="technician-identity-search"
                label={he ? "חיפוש לפי שם" : "Find your name"}
                onChange={(event) => setQuery(event.target.value)}
                type="search"
                value={query}
              />
            </div>
          ) : null}
          <fieldset className="technician-identity__options">
            <legend className="or-visually-hidden">
              {he ? "פרופיל טכנאי" : "Technician profile"}
            </legend>
            {visible.map((candidate) => (
              <label
                className="technician-identity__option"
                data-selected={candidate.id === selectedId || undefined}
                key={candidate.id}
              >
                <input
                  checked={candidate.id === selectedId}
                  name="technicianId"
                  onChange={() => {
                    setSelectedId(candidate.id);
                    setEmployeeIdentifier("");
                    setError(undefined);
                  }}
                  type="radio"
                  value={candidate.id}
                />
                <span
                  aria-hidden="true"
                  className="technician-identity__avatar"
                >
                  {initials(candidate.fullName)}
                </span>
                <span className="technician-identity__name">
                  <strong dir="auto">{candidate.fullName}</strong>
                  <small>
                    {technicianIdentityLabel(
                      candidate.identityVerification,
                      he,
                    )}
                  </small>
                </span>
              </label>
            ))}
            {visible.length === 0 ? (
              <p className="technician-identity__empty" role="status">
                {he ? "לא נמצא טכנאי בשם הזה." : "No technician matches."}
              </p>
            ) : null}
          </fieldset>

          {selected?.requiresEmployeeIdentifier === true ? (
            <Input
              autoCapitalize="characters"
              autoComplete="off"
              hint={
                he
                  ? "מאמת שאתם הטכנאי שנבחר. המספר אינו מוצג במכשיר."
                  : "Confirms you are the selected technician. It is never shown on the device."
              }
              id="technician-identity-employee"
              label={he ? "מספר עובד" : "Employee ID"}
              name="employeeIdentifier"
              onChange={(event) => setEmployeeIdentifier(event.target.value)}
              required
              spellCheck={false}
              value={employeeIdentifier}
            />
          ) : selected === undefined ? null : (
            <p className="field-service-form__hint">
              {he
                ? "לפרופיל הזה אין מספר עובד; הבחירה תירשם כהצהרה עצמית."
                : "This profile has no employee ID on file, so the choice is recorded as self-declared."}
            </p>
          )}

          {error === undefined ? null : (
            <InlineFeedback description={error} tone="critical" />
          )}

          <Button
            busy={pending}
            className="technician-identity__submit"
            disabled={selected === undefined || pending}
            type="submit"
          >
            <BadgeCheck aria-hidden="true" size={17} />
            {selected === undefined
              ? he
                ? "בחרו את הפרופיל שלכם"
                : "Choose your profile"
              : he
                ? `התחלת עבודה בתור ${selected.fullName}`
                : `Start working as ${selected.fullName}`}
          </Button>
        </form>
      )}
    </Surface>
  );
}

/** Shows who this device is working as and lets a shared device switch. */
export function TechnicianSessionBanner({
  shared,
  technician,
}: {
  readonly shared: boolean;
  readonly technician: SessionTechnician;
}) {
  const he = useLocale().startsWith("he");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function release() {
    setPending(true);
    setError(undefined);
    try {
      await crmMutation(
        "/api/field-service/session-technician",
        {},
        { method: "DELETE" },
      );
      setConfirming(false);
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : he
            ? "ההחלפה נכשלה. נסו שוב."
            : "The switch failed. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-label={he ? "הטכנאי במכשיר הזה" : "Technician on this device"}
      className="technician-session-banner"
    >
      <span aria-hidden="true" className="technician-session-banner__avatar">
        {initials(technician.fullName)}
      </span>
      <div className="technician-session-banner__copy">
        <small>{he ? "עובד/ת כעת בתור" : "Working as"}</small>
        <strong dir="auto">{technician.fullName}</strong>
      </div>
      <div className="technician-session-banner__meta">
        <Badge
          label={technicianIdentityLabel(technician.identityVerification, he)}
          tone={
            technician.identityVerification === "verified"
              ? "positive"
              : "neutral"
          }
        />
      </div>
      {shared ? (
        <Button
          className="technician-session-banner__switch"
          onClick={() => {
            setError(undefined);
            setConfirming(true);
          }}
          size="small"
          variant="secondary"
        >
          <Repeat2 aria-hidden="true" size={15} />
          {he ? "החלפת טכנאי" : "Switch technician"}
        </Button>
      ) : null}
      <ConfirmDialog
        busy={pending}
        cancelLabel={he ? "ביטול" : "Cancel"}
        confirmLabel={he ? "החלפת טכנאי" : "Switch technician"}
        description={
          he
            ? `המכשיר יפסיק לעבוד בתור ${technician.fullName}. תיקים, ביקורים ודוחות שכבר נשמרו נשארים משויכים ל-${technician.fullName}.`
            : `This device stops working as ${technician.fullName}. Cases, visits and reports already saved stay assigned to ${technician.fullName}.`
        }
        onCancel={() => {
          if (!pending) setConfirming(false);
        }}
        onConfirm={() => void release()}
        open={confirming}
        title={
          he ? "להחליף טכנאי במכשיר?" : "Switch technician on this device?"
        }
      >
        {error === undefined ? null : (
          <InlineFeedback description={error} tone="critical" />
        )}
      </ConfirmDialog>
    </section>
  );
}
