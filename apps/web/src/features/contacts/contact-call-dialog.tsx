"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ContactDetail } from "@or-on/crm";
import type { FlowSummary } from "@or-on/api-client";
import { Button, ConfirmDialog, Dialog, Select } from "@or-on/ui";
import { useCapability } from "../access";
import { voiceMutation } from "../voice";
import { errorMessage } from "../../i18n/error-message";

export function ContactCallDialog({
  contact,
  enabled,
  flows,
  open,
  onClose,
}: {
  readonly contact: ContactDetail;
  readonly enabled: boolean;
  readonly flows: readonly FlowSummary[];
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const canCall = useCapability("voice:operate");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [started, setStarted] = useState(false);
  const [flowId, setFlowId] = useState(flows[0]?.flow_id ?? "");
  const [gender, setGender] = useState<"" | "male" | "female">("");
  const [review, setReview] = useState<{
    readonly flowId: string;
    readonly gender: "male" | "female";
  }>();
  const identity = contact.identities.find(
    (item) =>
      (item.channel === "phone" || item.channel === "whatsapp") &&
      item.normalizedValue !== null &&
      item.validationStatus !== "invalid" &&
      item.validationStatus !== "revoked",
  );
  const eligible =
    enabled &&
    canCall &&
    contact.voiceConsent === "granted" &&
    contact.lifecycleStatus === "active" &&
    identity !== undefined;
  const ready = eligible && flowId !== "" && gender !== "" && !pending;
  function invalidate() {
    setReview(undefined);
    setStarted(false);
  }
  async function call() {
    if (!ready || review?.flowId !== flowId || review.gender !== gender) return;
    setPending(true);
    setError(undefined);
    try {
      await voiceMutation("/api/voice/real-calls", {
        contactId: contact.id,
        flowId: review.flowId,
        callerGender: review.gender,
        explicitApproval: true,
        idempotencyKey: crypto.randomUUID(),
      });
      setStarted(true);
      setReview(undefined);
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught, t, "tenantPrimary.callFailed"));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Dialog
        className="contact-call-dialog"
        title={t("tenantPrimary.call")}
        description={t("tenantPrimary.callHint")}
        open={open}
        closeLabel={t("common.close")}
        onClose={() => {
          if (!pending) onClose();
        }}
      >
        <div className="contact-call-dialog__recipient">
          <span
            className="contact-call-dialog__recipient-mark"
            aria-hidden="true"
          >
            {contact.name.trim().charAt(0).toLocaleUpperCase() || "#"}
          </span>
          <p>
            <strong>
              <bdi>{contact.name}</bdi>
            </strong>
            <span>
              <bdi>{identity?.normalizedValue ?? t("common.notSet")}</bdi>
            </span>
          </p>
        </div>
        {!eligible ? (
          <p className="public-note">
            {contact.voiceConsent !== "granted"
              ? t("contacts.callRequiresVoiceConsent")
              : t("tenantPrimary.callUnavailable")}
          </p>
        ) : null}
        {error && review === undefined ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <div className="contact-call-dialog__form">
          <Select
            data-dialog-initial-focus
            id="real-call-flow"
            label={t("contacts.voiceFlow")}
            value={flowId}
            disabled={pending || flows.length === 0}
            onChange={(event) => {
              setFlowId(event.target.value);
              invalidate();
            }}
          >
            {flows.length === 0 ? (
              <option value="">{t("contacts.noPublishedFlows")}</option>
            ) : (
              flows.map((flow) => (
                <option key={flow.flow_id} value={flow.flow_id}>
                  {flow.name} · v{flow.latest_version}
                </option>
              ))
            )}
          </Select>
          <Select
            id="real-call-address-form"
            label={t("contacts.callerAddressForm")}
            hint={t("contacts.callerAddressHint")}
            value={gender}
            disabled={pending}
            onChange={(event) => {
              setGender(
                event.target.value === "male" || event.target.value === "female"
                  ? event.target.value
                  : "",
              );
              invalidate();
            }}
          >
            <option value="">{t("contacts.callerAddressRequired")}</option>
            <option value="male">{t("contacts.callerAddressMale")}</option>
            <option value="female">{t("contacts.callerAddressFemale")}</option>
          </Select>
          {started ? (
            <p className="form-success" role="status">
              {t("tenantPrimary.callStarted")}
            </p>
          ) : null}
          <div className="contact-call-dialog__actions">
            <Button
              disabled={!ready}
              onClick={() => {
                if (ready) setReview({ flowId, gender });
              }}
            >
              {t("tenantPrimary.call")}
            </Button>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={review !== undefined}
        busy={pending}
        destructive
        title={t("tenantPrimary.callReview")}
        description={t("tenantPrimary.callConfirm", {
          addressForm: t(
            review?.gender === "female"
              ? "contacts.callerAddressFemale"
              : "contacts.callerAddressMale",
          ),
        })}
        confirmLabel={t("tenantPrimary.call")}
        cancelLabel={t("common.cancel")}
        confirmDisabled={
          !ready || review?.flowId !== flowId || review.gender !== gender
        }
        onCancel={() => setReview(undefined)}
        onConfirm={() => void call()}
      >
        <p>
          <bdi>{contact.name}</bdi> · <bdi>{identity?.normalizedValue}</bdi>
        </p>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
