"use client";

import type { SessionTechnician } from "@or-on/crm";
import {
  Badge,
  Button,
  ConfirmDialog,
  InlineFeedback,
  Input,
  Surface,
} from "@or-on/ui";
import { BadgeCheck, Repeat2 } from "lucide-react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, type SyntheticEvent } from "react";

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
 * One generic identification form for every technician sharing the account:
 * the technician types their own details, and the server binds them to this
 * browser session alone. Other devices on the same account keep their own
 * technician, and an employee identifier already held by another technician
 * profile is refused.
 */
export function TechnicianIdentityGate() {
  const he = useLocale().startsWith("he");
  const router = useRouter();
  const headingId = useId();
  const [fullName, setFullName] = useState("");
  const [employeeIdentifier, setEmployeeIdentifier] = useState("");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const ready = fullName.trim().length >= 2 && employeeIdentifier.trim() !== "";

  async function identify(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await crmMutation("/api/field-service/session-technician", {
        fullName: fullName.trim(),
        employeeIdentifier: employeeIdentifier.trim(),
        ...(phone.trim() === "" ? {} : { phone: phone.trim() }),
      });
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : he
            ? "לא ניתן לאשר את הזהות. נסו שוב."
            : "Your details could not be confirmed. Try again.",
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
          <BadgeCheck size={22} />
        </span>
        <div>
          <span className="eyebrow">
            {he ? "כניסת טכנאים משותפת" : "Shared technician sign-in"}
          </span>
          <h2 id={headingId}>
            {he ? "הזינו את הפרטים שלכם" : "Enter your details to start"}
          </h2>
          <p>
            {he
              ? "הפרטים משויכים למכשיר הזה בלבד. תיקים, ביקורים ודוחות יירשמו על שמכם, ומכשירים אחרים המחוברים לאותו חשבון שומרים על הטכנאי שלהם."
              : "Your details apply to this device only. Cases, visits and reports are recorded in your name, and other devices signed in to the same account keep their own technician."}
          </p>
        </div>
      </header>

      <form
        className="technician-identity__form"
        onSubmit={(event) => void identify(event)}
      >
        <Input
          autoComplete="name"
          id="technician-identity-name"
          label={he ? "שם מלא" : "Full name"}
          name="fullName"
          onChange={(event) => setFullName(event.target.value)}
          required
          value={fullName}
        />
        <Input
          autoCapitalize="characters"
          autoComplete="off"
          hint={
            he
              ? "מזהה העובד שלכם. הוא מקשר בין הביקורים והדוחות שלכם לאורך זמן."
              : "Your employee ID. It links your visits and reports over time."
          }
          id="technician-identity-employee"
          label={he ? "מספר עובד" : "Employee ID"}
          name="employeeIdentifier"
          onChange={(event) => setEmployeeIdentifier(event.target.value)}
          required
          spellCheck={false}
          value={employeeIdentifier}
        />
        <Input
          autoComplete="tel"
          id="technician-identity-phone"
          inputMode="tel"
          label={he ? "טלפון (לא חובה)" : "Contact number (optional)"}
          name="phone"
          onChange={(event) => setPhone(event.target.value)}
          type="tel"
          value={phone}
        />

        {error === undefined ? null : (
          <InlineFeedback description={error} tone="critical" />
        )}

        <Button
          busy={pending}
          className="technician-identity__submit"
          disabled={!ready || pending}
          type="submit"
        >
          <BadgeCheck aria-hidden="true" size={17} />
          {he ? "התחלת עבודה" : "Start working"}
        </Button>
      </form>
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
