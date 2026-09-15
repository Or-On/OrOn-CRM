"use client";

import type {
  FieldServiceFeatureState,
  ReportRevision,
  ServiceCaseDossier,
  ServiceCaseLinkCandidates,
  ServiceCaseStatus,
  ServiceVisit,
  TechnicianSummary,
} from "@or-on/crm";
import { nextServiceCaseStatuses } from "@or-on/crm/field-service-domain";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  InlineFeedback,
  Input,
  Select,
  Surface,
  Textarea,
} from "@or-on/ui";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Download,
  FileCheck2,
  FileImage,
  MessageCircleMore,
  Link2,
  PhoneCall,
  Plus,
  ScanText,
  ShieldCheck,
  UploadCloud,
  UserRoundCheck,
} from "lucide-react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type SyntheticEvent } from "react";

import { crmMutation, csrfToken } from "../crm";

type UploadCategory =
  | "fault"
  | "module"
  | "product_label"
  | "repair"
  | "environment"
  | "document"
  | "arrival_signature"
  | "departure_signature";

const uploadCategories = new Set<UploadCategory>([
  "fault",
  "module",
  "product_label",
  "repair",
  "environment",
  "document",
  "arrival_signature",
  "departure_signature",
]);

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

async function uploadEvidence(
  endpoint: string,
  fields: Record<string, string>,
  file: File,
  idempotencyKey: string,
  onProgress: (value: number) => void,
  onRequest: (request: XMLHttpRequest | undefined) => void,
): Promise<{ objectId: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set("file", file);
    const request = new XMLHttpRequest();
    request.open("POST", endpoint);
    request.timeout = 120_000;
    request.setRequestHeader("x-csrf-token", csrfToken());
    request.setRequestHeader("idempotency-key", idempotencyKey);
    onRequest(request);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      let payload: unknown;
      try {
        payload = JSON.parse(request.responseText) as unknown;
      } catch {
        reject(new Error("The upload returned an unreadable response"));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(
          new Error(
            payload !== null &&
              typeof payload === "object" &&
              "error" in payload &&
              typeof payload.error === "string"
              ? payload.error
              : "Upload failed",
          ),
        );
        return;
      }
      if (
        payload === null ||
        typeof payload !== "object" ||
        !("objectId" in payload) ||
        typeof payload.objectId !== "string"
      ) {
        reject(new Error("The upload did not return an object identifier"));
        return;
      }
      resolve({ objectId: payload.objectId });
    });
    request.addEventListener("error", () =>
      reject(new Error("Upload connection failed")),
    );
    request.addEventListener("timeout", () =>
      reject(
        new Error(
          "The upload timed out. Retry with the preserved request to reconcile its result.",
        ),
      ),
    );
    request.addEventListener("abort", () =>
      reject(new Error("Upload cancelled. No attendance result was assumed.")),
    );
    request.addEventListener("loadend", () => onRequest(undefined));
    request.send(form);
  });
}

function statusTone(status: ServiceCaseStatus) {
  if (status === "completed" || status === "closed") return "positive" as const;
  if (status === "cancelled") return "critical" as const;
  if (status === "in_progress") return "warning" as const;
  return "neutral" as const;
}

function DialogError({ message }: { readonly message: string | undefined }) {
  return message === undefined ? null : (
    <InlineFeedback
      className="field-service-dialog-feedback"
      description={message}
      tone="critical"
    />
  );
}

export function ServiceCaseWorkspace({
  canManage,
  canOperate,
  canReadVoice,
  dossier,
  feature,
  linkCandidates,
  technicians,
  timezone,
}: {
  readonly canManage: boolean;
  readonly canOperate: boolean;
  readonly canReadVoice: boolean;
  readonly dossier: ServiceCaseDossier;
  readonly feature: FieldServiceFeatureState;
  readonly linkCandidates: ServiceCaseLinkCandidates | undefined;
  readonly technicians: readonly TechnicianSummary[];
  readonly timezone: string;
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const router = useRouter();
  const serviceCase = dossier.serviceCase;
  const [pendingAction, setPendingAction] = useState<string>();
  const [error, setError] = useState<string>();
  const [visitOpen, setVisitOpen] = useState(false);
  const [identityVisit, setIdentityVisit] = useState<ServiceVisit>();
  const [reportVisit, setReportVisit] = useState<ServiceVisit>();
  const [evidenceVisit, setEvidenceVisit] = useState<ServiceVisit>();
  const [evidenceReportRevisionId, setEvidenceReportRevisionId] =
    useState<string>();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>();
  const activeUpload = useRef<XMLHttpRequest | undefined>(undefined);
  const [uploadRequest, setUploadRequest] = useState<{
    readonly scope: string;
    readonly key: string;
  }>();
  const [latestReport, setLatestReport] = useState<ReportRevision>();
  const [identifiedVisits, setIdentifiedVisits] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const conversations = useMemo(
    () =>
      dossier.conversations.flatMap((conversation) => conversation.messages),
    [dossier.conversations],
  );

  const pending = pendingAction !== undefined;
  const dialogOpen =
    visitOpen ||
    identityVisit !== undefined ||
    reportVisit !== undefined ||
    uploadOpen ||
    linkOpen;

  async function run(action: string, operation: () => Promise<void>) {
    setPendingAction(action);
    setError(undefined);
    try {
      await operation();
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : he
            ? "הפעולה נכשלה"
            : "The operation failed",
      );
    } finally {
      setPendingAction(undefined);
    }
  }

  function openVisitDialog() {
    setError(undefined);
    setVisitOpen(true);
  }

  function closeVisitDialog() {
    setError(undefined);
    setVisitOpen(false);
  }

  function openIdentityDialog(visit: ServiceVisit) {
    setError(undefined);
    setIdentityVisit(visit);
  }

  function closeIdentityDialog() {
    setError(undefined);
    setIdentityVisit(undefined);
  }

  function openLinkDialog() {
    setError(undefined);
    setLinkOpen(true);
  }

  function closeLinkDialog() {
    setError(undefined);
    setLinkOpen(false);
  }

  function openUploadDialog(
    visit: ServiceVisit | undefined,
    reportRevisionId?: string,
  ) {
    setError(undefined);
    setEvidenceVisit(visit);
    setEvidenceReportRevisionId(reportRevisionId);
    setUploadOpen(true);
  }

  function closeUploadDialog() {
    setError(undefined);
    setUploadOpen(false);
  }

  function closeReportDialog() {
    setError(undefined);
    setReportVisit(undefined);
    setLatestReport(undefined);
  }

  async function updateStatus(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run("update-status", async () => {
      await crmMutation(
        `/api/field-service/cases/${serviceCase.id}`,
        { status: form.get("status"), reason: form.get("reason") },
        { method: "PATCH" },
      );
    });
  }

  async function createVisit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const appointmentId = formText(form, "appointmentId");
    await run("create-visit", async () => {
      await crmMutation("/api/field-service/visits", {
        caseId: serviceCase.id,
        technicianId: form.get("technicianId"),
        appointmentId: appointmentId === "" ? null : appointmentId,
      });
      closeVisitDialog();
    });
  }

  async function identify(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (identityVisit === undefined) return;
    const form = new FormData(event.currentTarget);
    await run("identify-technician", async () => {
      await crmMutation(
        `/api/field-service/visits/${identityVisit.id}/identity`,
        Object.fromEntries(form.entries()),
      );
      setIdentifiedVisits((current) => new Set([...current, identityVisit.id]));
      closeIdentityDialog();
    });
  }

  async function openReport(visit: ServiceVisit) {
    setLatestReport(undefined);
    setReportVisit(undefined);
    await run(`open-report:${visit.id}`, async () => {
      const payload = await crmMutation<{ report: ReportRevision }>(
        "/api/field-service/reports",
        { caseId: serviceCase.id, visitId: visit.id },
      );
      setLatestReport(payload.report);
      setReportVisit(visit);
      setEvidenceVisit(visit);
      setEvidenceReportRevisionId(payload.report.id);
    });
  }

  async function saveReport(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (latestReport === undefined) return;
    const form = new FormData(event.currentTarget);
    const partReplaced = form.get("partReplaced");
    await run("save-report", async () => {
      const payload = await crmMutation<{ report: ReportRevision }>(
        `/api/field-service/reports/${latestReport.id}`,
        {
          diagnosis: form.get("diagnosis"),
          workPerformed: form.get("workPerformed"),
          partReplaced:
            partReplaced === "yes"
              ? true
              : partReplaced === "no"
                ? false
                : null,
          replacementPartDetails: form.get("replacementPartDetails"),
          technicianNotes: form.get("technicianNotes"),
        },
        { method: "PATCH" },
      );
      setLatestReport(payload.report);
    });
  }

  async function finalizeReport() {
    if (latestReport === undefined) return;
    await run("finalize-report", async () => {
      const payload = await crmMutation<{ report: ReportRevision }>(
        `/api/field-service/reports/${latestReport.id}/finalize`,
        {},
      );
      setLatestReport(payload.report);
    });
  }

  async function upload(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selectedFile = form.get("file");
    const capturedFile = form.get("cameraFile");
    const file =
      capturedFile instanceof File && capturedFile.size > 0
        ? capturedFile
        : selectedFile;
    const categoryValue = formText(form, "category");
    if (!uploadCategories.has(categoryValue as UploadCategory)) {
      setError(
        he ? "קטגוריית הראיה אינה תקינה" : "Evidence category is invalid",
      );
      return;
    }
    const category = categoryValue as UploadCategory;
    if (!(file instanceof File) || file.size < 1) {
      setError(
        he ? "יש לבחור קובץ או לצלם תמונה" : "Choose a file or take a photo",
      );
      return;
    }
    setPendingAction("upload-evidence");
    setError(undefined);
    setUploadProgress(0);
    try {
      const attendance =
        evidenceVisit !== undefined &&
        (category === "arrival_signature" ||
          category === "departure_signature");
      const scope = `${evidenceVisit?.id ?? "case"}:${category}`;
      const key =
        uploadRequest?.scope === scope
          ? uploadRequest.key
          : crypto.randomUUID();
      if (uploadRequest?.scope !== scope) setUploadRequest({ scope, key });
      await uploadEvidence(
        attendance
          ? `/api/field-service/visits/${evidenceVisit.id}/attendance`
          : "/api/field-service/attachments",
        {
          caseId: serviceCase.id,
          ...(attendance
            ? {
                kind:
                  category === "arrival_signature" ? "arrival" : "departure",
              }
            : {
                category,
                ...(evidenceVisit === undefined
                  ? {}
                  : { visitId: evidenceVisit.id }),
                ...(evidenceReportRevisionId === undefined
                  ? {}
                  : { reportRevisionId: evidenceReportRevisionId }),
                ...(category === "product_label" && feature.ocrEnabled
                  ? { runOcr: "true" }
                  : {}),
              }),
        },
        file,
        key,
        setUploadProgress,
        (request) => {
          activeUpload.current = request;
        },
      );
      setUploadRequest(undefined);
      closeUploadDialog();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Upload failed");
    } finally {
      setPendingAction(undefined);
      setUploadProgress(undefined);
    }
  }

  function cancelUpload() {
    activeUpload.current?.abort();
    activeUpload.current = undefined;
    closeUploadDialog();
  }

  async function confirmOcr(
    event: SyntheticEvent<HTMLFormElement>,
    ocrResultId: string,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run("confirm-ocr", async () => {
      await crmMutation(
        `/api/field-service/ocr/${ocrResultId}`,
        {
          fields: {
            productType: form.get("productType"),
            productModel: form.get("productModel"),
            serialNumber: form.get("serialNumber"),
          },
        },
        { method: "PATCH" },
      );
    });
  }

  async function linkEvidence(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const [sourceKind, sourceId] = formText(form, "source").split(":", 2);
    await run("link-evidence", async () => {
      await crmMutation(`/api/field-service/cases/${serviceCase.id}/links`, {
        sourceKind,
        sourceId,
      });
      closeLinkDialog();
    });
  }

  const nextStatuses = nextServiceCaseStatuses(serviceCase.status);

  return (
    <div className="service-case-workspace">
      <Link className="service-case-back" href="/field-service">
        <ArrowLeft aria-hidden="true" size={15} />
        {he ? "חזרה לשירות שטח" : "Back to field service"}
      </Link>
      <header className="service-case-hero">
        <div>
          <span className="eyebrow" dir="ltr">
            {serviceCase.reference}
          </span>
          <h1>{serviceCase.title}</h1>
          <p>
            {serviceCase.customerName}
            {serviceCase.serviceLocationName
              ? ` · ${serviceCase.serviceLocationName}`
              : ""}
          </p>
        </div>
        <div className="service-case-hero__actions">
          <Badge
            label={serviceCase.status.replaceAll("_", " ")}
            tone={statusTone(serviceCase.status)}
          />
          {canOperate ? (
            <Button onClick={openVisitDialog} variant="secondary">
              <Plus aria-hidden="true" size={16} />
              {he ? "ביקור נוסף" : "Add visit"}
            </Button>
          ) : null}
        </div>
      </header>

      {error && !dialogOpen ? (
        <InlineFeedback description={error} tone="critical" />
      ) : null}

      <div className="service-case-layout">
        <div className="service-case-main">
          <Surface className="service-case-section" level="raised">
            <header>
              <div>
                <span className="eyebrow">
                  {he ? "קובץ לקוח" : "Customer dossier"}
                </span>
                <h2>{serviceCase.customerName}</h2>
              </div>
              <Link href={`/contacts/${serviceCase.customerContactId}`}>
                {he ? "פתיחת לקוח" : "Open contact"}
              </Link>
            </header>
            <dl className="service-case-details">
              <div>
                <dt>{he ? "מזהה לאומי" : "National ID"}</dt>
                <dd dir="ltr">
                  {dossier.customer.nationalIdMasked ??
                    (he ? "לא סופק" : "Not supplied")}
                </dd>
              </div>
              <div>
                <dt>{he ? "אחריות" : "Warranty"}</dt>
                <dd>{serviceCase.warrantyStatus}</dd>
              </div>
              <div>
                <dt>{he ? "דגם" : "Model"}</dt>
                <dd dir="auto">{serviceCase.productModel ?? "—"}</dd>
              </div>
              <div>
                <dt>{he ? "מספר סידורי" : "Serial"}</dt>
                <dd dir="ltr">{serviceCase.serialNumber ?? "—"}</dd>
              </div>
            </dl>
            <p className="service-case-fault">{serviceCase.faultDescription}</p>
            <div className="service-case-classifications">
              {dossier.customer.classifications.length === 0 ? (
                <span>{he ? "ללא סיווג" : "No classification"}</span>
              ) : (
                dossier.customer.classifications.map((item) => (
                  <Badge key={item.id} label={item.name} tone="neutral" />
                ))
              )}
            </div>
          </Surface>

          <Surface className="service-case-section" level="raised">
            <header>
              <div>
                <span className="eyebrow">
                  {he ? "ביקורים ונוכחות" : "Visits & attendance"}
                </span>
                <h2>{he ? "עבודת שטח" : "Field work"}</h2>
              </div>
            </header>
            {dossier.visits.length === 0 ? (
              <EmptyState
                title={he ? "אין עדיין ביקורים" : "No visits yet"}
                description={
                  he
                    ? "יצירת ביקור משמרת כל ביקור קודם בנפרד."
                    : "Create a visit; repeat visits retain their own attendance and report history."
                }
              />
            ) : (
              <div className="service-visit-list">
                {dossier.visits.map((visit) => {
                  const technician = technicians.find(
                    (item) => item.id === visit.technicianId,
                  );
                  return (
                    <article key={visit.id}>
                      <div className="service-visit-index">
                        {visit.visitNumber}
                      </div>
                      <div>
                        <h3>
                          {technician?.fullName ??
                            (he ? "טכנאי" : "Technician")}
                        </h3>
                        <p>
                          <Clock3 aria-hidden="true" size={14} />
                          {visit.arrivalAt
                            ? new Intl.DateTimeFormat(locale, {
                                dateStyle: "medium",
                                timeStyle: "short",
                                timeZone: timezone,
                              }).format(new Date(visit.arrivalAt))
                            : he
                              ? "טרם בוצעה הגעה"
                              : "Arrival not signed"}
                          {visit.durationSeconds === null
                            ? ""
                            : ` · ${String(Math.round(visit.durationSeconds / 60))} min`}
                        </p>
                        <div>
                          <Badge
                            label={visit.status}
                            tone={
                              visit.status === "departed" ||
                              visit.status === "reported"
                                ? "positive"
                                : "neutral"
                            }
                          />
                          {visit.arrivalSignatureObjectId ? (
                            <Badge
                              label={he ? "הגעה חתומה" : "Arrival signed"}
                              tone="positive"
                            />
                          ) : null}
                          {visit.departureSignatureObjectId ? (
                            <Badge
                              label={he ? "יציאה חתומה" : "Departure signed"}
                              tone="positive"
                            />
                          ) : null}
                        </div>
                      </div>
                      {canOperate ? (
                        <div className="service-visit-actions">
                          <Button
                            onClick={() => openIdentityDialog(visit)}
                            size="small"
                            variant="quiet"
                          >
                            <UserRoundCheck aria-hidden="true" size={15} />
                            {identifiedVisits.has(visit.id)
                              ? he
                                ? "זוהה"
                                : "Identified"
                              : he
                                ? "זיהוי"
                                : "Identify"}
                          </Button>
                          <Button
                            busy={pendingAction === `open-report:${visit.id}`}
                            disabled={pending}
                            onClick={() => {
                              void openReport(visit);
                            }}
                            size="small"
                            variant="secondary"
                          >
                            <FileCheck2 aria-hidden="true" size={15} />
                            {he ? "דוח" : "Report"}
                          </Button>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </Surface>

          <Surface className="service-case-section" level="raised">
            <header>
              <div>
                <span className="eyebrow">{he ? "ראיות" : "Evidence"}</span>
                <h2>{he ? "תמונות ומסמכים" : "Photos & documents"}</h2>
              </div>
              {canOperate ? (
                <Button
                  onClick={() =>
                    openUploadDialog(dossier.visits.at(-1), undefined)
                  }
                  size="small"
                  variant="secondary"
                >
                  <UploadCloud aria-hidden="true" size={15} />
                  {he ? "העלאה" : "Upload"}
                </Button>
              ) : null}
            </header>
            {dossier.attachments.length === 0 ? (
              <EmptyState
                title={he ? "אין ראיות מצורפות" : "No evidence attached"}
                description={
                  he
                    ? "צלמו מהטלפון או בחרו קובץ מהמחשב."
                    : "Capture from a phone camera or choose a file from a computer."
                }
              />
            ) : (
              <div className="service-evidence-grid">
                {dossier.attachments.map((item) => {
                  const ocr = (dossier.ocrResults ?? []).find(
                    (result) => result.attachmentId === item.id,
                  );
                  const values = {
                    ...ocr?.proposedFields,
                    ...ocr?.confirmedFields,
                  };
                  return (
                    <article className="service-evidence-card" key={item.id}>
                      <a
                        href={`/api/field-service/attachments/${item.objectId}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <span>
                          <FileImage aria-hidden="true" size={18} />
                        </span>
                        <strong>{item.category.replaceAll("_", " ")}</strong>
                        <small>
                          {Math.ceil(item.byteSize / 1024)} KB ·{" "}
                          {item.processingStatus}
                        </small>
                        <Download aria-hidden="true" size={15} />
                      </a>
                      {ocr ? (
                        <details className="service-ocr-review">
                          <summary>
                            <ScanText aria-hidden="true" size={14} />
                            OCR · {ocr.status.replaceAll("_", " ")}
                            {ocr.confidence === null
                              ? ""
                              : ` · ${String(Math.round(ocr.confidence * 100))}%`}
                          </summary>
                          {ocr.errorSafe ? (
                            <InlineFeedback description={ocr.errorSafe} />
                          ) : null}
                          {canOperate &&
                          (ocr.status === "review_required" ||
                            ocr.status === "failed") ? (
                            <form
                              onSubmit={(event) =>
                                void confirmOcr(event, ocr.id)
                              }
                            >
                              <Input
                                defaultValue={values.productType ?? ""}
                                id={`ocr-product-type-${ocr.id}`}
                                label={he ? "סוג מוצר" : "Product type"}
                                name="productType"
                              />
                              <Input
                                defaultValue={values.productModel ?? ""}
                                id={`ocr-product-model-${ocr.id}`}
                                label={he ? "דגם" : "Model"}
                                name="productModel"
                              />
                              <Input
                                defaultValue={values.serialNumber ?? ""}
                                id={`ocr-serial-${ocr.id}`}
                                label={he ? "מספר סידורי" : "Serial number"}
                                name="serialNumber"
                              />
                              <Button
                                busy={pendingAction === "confirm-ocr"}
                                disabled={pending}
                                size="small"
                                type="submit"
                              >
                                {he ? "אישור תיקונים" : "Confirm corrections"}
                              </Button>
                            </form>
                          ) : (
                            <dl>
                              {Object.entries(values).map(([key, value]) => (
                                <div key={key}>
                                  <dt>{key}</dt>
                                  <dd dir="auto">{value}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </details>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </Surface>

          <Surface className="service-case-section" level="raised">
            <header>
              <div>
                <span className="eyebrow">
                  {he ? "היסטוריית מקור" : "Source history"}
                </span>
                <h2>{he ? "WhatsApp ושיחות" : "WhatsApp & calls"}</h2>
              </div>
              {canManage ? (
                <Button
                  onClick={openLinkDialog}
                  size="small"
                  variant="secondary"
                >
                  <Link2 aria-hidden="true" size={15} />
                  {he ? "קישור ראיות" : "Link evidence"}
                </Button>
              ) : null}
            </header>
            <div className="service-source-grid">
              <div>
                <h3>
                  <MessageCircleMore aria-hidden="true" size={16} />
                  WhatsApp{" "}
                  <Badge label={String(conversations.length)} tone="neutral" />
                </h3>
                {conversations.length === 0 ? (
                  <p>{he ? "לא קושרה שיחה." : "No conversation linked."}</p>
                ) : (
                  <ol>
                    {conversations.map((message) => (
                      <li key={message.id}>
                        <span>{message.senderType}</span>
                        <p dir="auto">
                          {message.contentText ?? `[${message.contentType}]`}
                        </p>
                        <time dateTime={message.createdAt}>
                          {new Intl.DateTimeFormat(locale, {
                            dateStyle: "short",
                            timeStyle: "short",
                            timeZone: timezone,
                          }).format(new Date(message.createdAt))}
                        </time>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div>
                <h3>
                  <PhoneCall aria-hidden="true" size={16} />
                  {he ? "שיחות" : "Calls"}{" "}
                  <Badge label={String(dossier.calls.length)} tone="neutral" />
                </h3>
                {dossier.calls.length === 0 ? (
                  <p>{he ? "לא קושרו שיחות." : "No calls linked."}</p>
                ) : (
                  <ol>
                    {dossier.calls.map((call) => (
                      <li key={call.sessionId}>
                        <span>
                          {call.direction} · {call.status}
                        </span>
                        <p>
                          {call.outcome ??
                            (he ? "ללא תוצאה מתועדת" : "No recorded outcome")}
                        </p>
                        <small>
                          {he ? "הקלטה" : "Recording"}: {call.recordingStatus} ·{" "}
                          {he ? "תמלול" : "Transcript"}: {call.transcriptStatus}
                        </small>
                        {canReadVoice ? (
                          <Link
                            className="service-source-link"
                            href={`/voice/calls/${call.sessionId}`}
                          >
                            {he ? "פתיחת שיחה וראיות" : "Open call evidence"}
                          </Link>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          </Surface>
        </div>

        <aside className="service-case-aside">
          {canOperate ? (
            <Surface className="service-case-section" level="raised">
              <header>
                <div>
                  <span className="eyebrow">
                    {he ? "מחזור חיים" : "Lifecycle"}
                  </span>
                  <h2>{he ? "עדכון סטטוס" : "Update status"}</h2>
                </div>
              </header>
              {nextStatuses.length === 0 ? (
                <p className="public-note">
                  {he
                    ? "התיק סגור ואין מעבר סטטוס נוסף."
                    : "This case is closed and has no further status transition."}
                </p>
              ) : (
                <form
                  className="service-status-form"
                  onSubmit={(event) => void updateStatus(event)}
                >
                  <Select
                    id="service-case-status"
                    label={he ? "סטטוס הבא" : "Next status"}
                    name="status"
                    required
                  >
                    {nextStatuses.map((status) => (
                      <option key={status} value={status}>
                        {status.replaceAll("_", " ")}
                      </option>
                    ))}
                  </Select>
                  <Textarea
                    id="service-case-status-reason"
                    label={he ? "סיבה" : "Reason"}
                    name="reason"
                    rows={2}
                  />
                  <Button
                    busy={pendingAction === "update-status"}
                    disabled={pending}
                    type="submit"
                  >
                    {he ? "עדכון" : "Update"}
                  </Button>
                </form>
              )}
            </Surface>
          ) : null}
          <Surface
            className="service-case-section service-case-timeline"
            level="raised"
          >
            <header>
              <div>
                <span className="eyebrow">
                  {he ? "עקיבות" : "Traceability"}
                </span>
                <h2>{he ? "היסטוריית תיק" : "Case history"}</h2>
              </div>
            </header>
            <ol>
              {dossier.statusHistory.map((item) => (
                <li key={`${item.changedAt}-${item.toStatus}`}>
                  <span>
                    <CheckCircle2 aria-hidden="true" size={14} />
                  </span>
                  <div>
                    <strong>{item.toStatus.replaceAll("_", " ")}</strong>
                    <p>
                      {item.reason ?? (he ? "שינוי סטטוס" : "Status changed")}
                    </p>
                    <time dateTime={item.changedAt}>
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: timezone,
                      }).format(new Date(item.changedAt))}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          </Surface>
          <Surface className="service-case-section" level="raised">
            <header>
              <div>
                <span className="eyebrow">{he ? "עיבוד" : "Processing"}</span>
                <h2>{he ? "סיכומים" : "Summaries"}</h2>
              </div>
            </header>
            {dossier.summaries.length === 0 ? (
              <InlineFeedback
                description={
                  he
                    ? "אין סיכום AI. היסטוריית המקור נשמרת במלואה."
                    : "No AI summary is available. Complete source history remains preserved."
                }
              />
            ) : (
              dossier.summaries.map((summary, index) => (
                <div
                  className="service-summary"
                  key={`${summary.sourceKind}-${String(index)}`}
                >
                  <Badge
                    label={`${summary.sourceKind} · ${summary.status}`}
                    tone={
                      summary.status === "completed" ? "positive" : "neutral"
                    }
                  />
                  <p>{summary.summary ?? (he ? "אין תוכן" : "No content")}</p>
                </div>
              ))
            )}
          </Surface>
        </aside>
      </div>

      <Dialog
        closeLabel={he ? "סגירה" : "Close"}
        description={
          he
            ? "ניתן לקשר רק מקורות המשויכים ללקוח או לאיש הקשר המדווח."
            : "Only sources bound to the customer or reporting contact can be linked."
        }
        onClose={closeLinkDialog}
        open={linkOpen}
        title={he ? "קישור מקור לתיק" : "Link source to case"}
      >
        <form
          className="field-service-form"
          onSubmit={(event) => void linkEvidence(event)}
        >
          <DialogError message={error} />
          <Select
            id="case-link-source"
            label={he ? "מקור" : "Source"}
            name="source"
            required
          >
            <option value="">{he ? "בחירת מקור" : "Select a source"}</option>
            <optgroup label="WhatsApp">
              {(linkCandidates?.conversations ?? [])
                .filter((candidate) => !candidate.linked)
                .map((candidate) => (
                  <option
                    key={candidate.id}
                    value={`conversation:${candidate.id}`}
                  >
                    {candidate.status} · {candidate.id.slice(0, 8)}
                    {candidate.linkedCaseCount > 0
                      ? ` · ${String(candidate.linkedCaseCount)} existing link(s)`
                      : ""}
                  </option>
                ))}
            </optgroup>
            <optgroup label={he ? "שיחות טלפון" : "Telephone calls"}>
              {(linkCandidates?.calls ?? [])
                .filter((candidate) => !candidate.linked)
                .map((candidate) => (
                  <option
                    key={candidate.sessionId}
                    value={`call:${candidate.sessionId}`}
                  >
                    {candidate.status} · {candidate.sessionId.slice(0, 8)}
                    {candidate.linkedCaseCount > 0
                      ? ` · ${String(candidate.linkedCaseCount)} existing link(s)`
                      : ""}
                  </option>
                ))}
            </optgroup>
          </Select>
          <InlineFeedback
            description={
              he
                ? "השרת מאמת מחדש את הקשר ללקוח. התאמה לפי מספר טלפון בלבד אינה מתקבלת."
                : "The server revalidates the customer relationship. Phone-number-only matching is not accepted."
            }
          />
          <div className="field-service-form__actions">
            <Button onClick={closeLinkDialog} type="button" variant="quiet">
              {he ? "ביטול" : "Cancel"}
            </Button>
            <Button
              busy={pendingAction === "link-evidence"}
              disabled={pending}
              type="submit"
            >
              <Link2 aria-hidden="true" size={15} />
              {he ? "קישור" : "Link source"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        closeLabel={he ? "סגירה" : "Close"}
        onClose={closeVisitDialog}
        open={visitOpen}
        title={he ? "ביקור נוסף" : "Add visit"}
      >
        <form
          className="field-service-form"
          onSubmit={(event) => void createVisit(event)}
        >
          <DialogError message={error} />
          <Select
            id="case-visit-technician"
            label={he ? "טכנאי" : "Technician"}
            name="technicianId"
            required
          >
            <option value="">{he ? "בחירת טכנאי" : "Select technician"}</option>
            {technicians.map((item) => (
              <option key={item.id} value={item.id}>
                {item.fullName}
              </option>
            ))}
          </Select>
          <Select
            id="case-visit-appointment"
            label={he ? "תזמון מקושר" : "Linked appointment"}
            name="appointmentId"
          >
            <option value="">{he ? "ללא" : "None"}</option>
            {dossier.appointments
              .filter((item) => item.status === "scheduled")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: item.timezone,
                  }).format(new Date(item.startsAt))}{" "}
                  · {item.technicianName}
                </option>
              ))}
          </Select>
          <div className="field-service-form__actions">
            <Button onClick={closeVisitDialog} type="button" variant="quiet">
              {he ? "ביטול" : "Cancel"}
            </Button>
            <Button
              busy={pendingAction === "create-visit"}
              disabled={pending}
              type="submit"
            >
              {he ? "יצירת ביקור" : "Create visit"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        closeLabel={he ? "סגירה" : "Close"}
        description={
          he
            ? "הזיהוי נשמר לביקור ולסשן הנוכחי בלבד."
            : "Identity is bound only to this visit and current session."
        }
        onClose={closeIdentityDialog}
        open={identityVisit !== undefined}
        title={he ? "זיהוי טכנאי" : "Identify technician"}
      >
        <form
          className="field-service-form"
          key={identityVisit?.id}
          onSubmit={(event) => void identify(event)}
        >
          <DialogError message={error} />
          <Select
            id="identity-technician"
            label={he ? "פרופיל טכנאי" : "Technician profile"}
            name="technicianId"
            required
            defaultValue={identityVisit?.technicianId ?? ""}
          >
            <option value={identityVisit?.technicianId ?? ""}>
              {technicians.find(
                (item) => item.id === identityVisit?.technicianId,
              )?.fullName ?? "Technician"}
            </option>
          </Select>
          <Input
            id="identity-name"
            label={he ? "שם מלא" : "Full name"}
            name="fullName"
            required
          />
          <Input
            id="identity-employee"
            label={he ? "מזהה טכנאי" : "Technician identifier"}
            name="employeeIdentifier"
          />
          <Input
            id="identity-contact"
            label={he ? "פרטי קשר" : "Contact information"}
            name="contactInformation"
          />
          <div className="field-service-form__actions">
            <Button onClick={closeIdentityDialog} type="button" variant="quiet">
              {he ? "ביטול" : "Cancel"}
            </Button>
            <Button
              busy={pendingAction === "identify-technician"}
              disabled={pending}
              type="submit"
            >
              <ShieldCheck aria-hidden="true" size={15} />
              {he ? "אישור זהות" : "Confirm identity"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        closeLabel={he ? "סגירה" : "Close"}
        {...(reportVisit === undefined
          ? {}
          : {
              description: `${he ? "ביקור" : "Visit"} ${String(reportVisit.visitNumber)}`,
            })}
        onClose={closeReportDialog}
        open={reportVisit !== undefined && latestReport !== undefined}
        title={he ? "דוח טכנאי" : "Technician report"}
      >
        {latestReport === undefined ? null : (
          <form
            className="service-report-form"
            onSubmit={(event) => void saveReport(event)}
          >
            <DialogError message={error} />
            <div className="service-report-meta">
              <Badge
                label={`${he ? "גרסה" : "Version"} ${String(latestReport.version)}`}
                tone="neutral"
              />
              <Badge
                label={latestReport.status}
                tone={
                  latestReport.status === "finalized" ? "positive" : "warning"
                }
              />
            </div>
            <Textarea
              defaultValue={latestReport.diagnosis ?? ""}
              disabled={latestReport.status === "finalized"}
              id="report-diagnosis"
              label={he ? "אבחון" : "Diagnosis"}
              name="diagnosis"
              required
              rows={3}
            />
            <Textarea
              defaultValue={latestReport.workPerformed ?? ""}
              disabled={latestReport.status === "finalized"}
              id="report-work"
              label={he ? "עבודה שבוצעה" : "Work performed"}
              name="workPerformed"
              required
              rows={3}
            />
            <Select
              defaultValue={
                latestReport.partReplaced === true
                  ? "yes"
                  : latestReport.partReplaced === false
                    ? "no"
                    : ""
              }
              disabled={latestReport.status === "finalized"}
              id="report-part-replaced"
              label={he ? "הוחלף חלק?" : "Part replaced?"}
              name="partReplaced"
              required
            >
              <option value="">{he ? "בחירה" : "Select"}</option>
              <option value="yes">{he ? "כן" : "Yes"}</option>
              <option value="no">{he ? "לא" : "No"}</option>
            </Select>
            <Input
              defaultValue={latestReport.replacementPartDetails ?? ""}
              disabled={latestReport.status === "finalized"}
              id="report-part-details"
              label={he ? "פרטי החלק" : "Replacement part details"}
              name="replacementPartDetails"
            />
            <Textarea
              defaultValue={latestReport.technicianNotes ?? ""}
              disabled={latestReport.status === "finalized"}
              id="report-notes"
              label={he ? "הערות טכנאי" : "Technician notes"}
              name="technicianNotes"
              rows={2}
            />
            <InlineFeedback
              description={
                he
                  ? "להשלמה נדרשות חתימות הגעה ויציאה, צילום תקלה וצילום מודול."
                  : "Finalization requires arrival and departure signatures, a fault photo, and a module photo."
              }
            />
            <div className="field-service-form__actions">
              {latestReport.status === "finalized" ? (
                <Link
                  className="or-button or-button--secondary or-button--medium"
                  href={`/field-service/reports/${latestReport.id}`}
                >
                  <Download aria-hidden="true" size={15} />
                  {he ? "פתיחת דוח" : "Open report"}
                </Link>
              ) : (
                <>
                  <Button
                    onClick={() => {
                      openUploadDialog(reportVisit, latestReport.id);
                      setReportVisit(undefined);
                    }}
                    type="button"
                    variant="quiet"
                  >
                    <UploadCloud aria-hidden="true" size={15} />
                    {he ? "הוספת ראיה" : "Add evidence"}
                  </Button>
                  <Button
                    busy={pendingAction === "save-report"}
                    disabled={pending}
                    type="submit"
                    variant="secondary"
                  >
                    {he ? "שמירת טיוטה" : "Save draft"}
                  </Button>
                  <Button
                    busy={pendingAction === "finalize-report"}
                    disabled={pending}
                    onClick={() => void finalizeReport()}
                    type="button"
                  >
                    {he ? "סיום וחתימה" : "Finalize report"}
                  </Button>
                </>
              )}
            </div>
          </form>
        )}
      </Dialog>

      <Dialog
        closeLabel={he ? "סגירה" : "Close"}
        onClose={cancelUpload}
        open={uploadOpen}
        title={he ? "העלאת ראיה" : "Upload evidence"}
      >
        <form
          className="field-service-form"
          onSubmit={(event) => void upload(event)}
        >
          <DialogError message={error} />
          <Select
            id="evidence-category"
            label={he ? "קטגוריה" : "Category"}
            name="category"
            required
          >
            <option value="fault">{he ? "צילום תקלה" : "Fault photo"}</option>
            <option value="module">
              {he ? "צילום מודול" : "Module photo"}
            </option>
            <option value="product_label">
              {he ? "תווית מוצר ל-OCR" : "Product label for OCR"}
            </option>
            <option value="repair">{he ? "תיקון" : "Repair"}</option>
            <option value="environment">{he ? "סביבה" : "Environment"}</option>
            <option value="document">{he ? "מסמך" : "Document"}</option>
            {evidenceVisit ? (
              <>
                <option value="arrival_signature">
                  {he ? "חתימת הגעה" : "Arrival signature"}
                </option>
                <option value="departure_signature">
                  {he ? "חתימת יציאה" : "Departure signature"}
                </option>
              </>
            ) : null}
          </Select>
          <div className="service-file-options">
            <label className="service-file-input">
              <span>
                <UploadCloud aria-hidden="true" size={24} />
                <strong>{he ? "בחירת קובץ" : "Choose a file"}</strong>
                <small>
                  {he
                    ? "JPEG, PNG, WebP, PDF או טקסט"
                    : "JPEG, PNG, WebP, PDF, or text"}
                </small>
              </span>
              <input
                accept="image/jpeg,image/png,image/webp,application/pdf,text/plain"
                name="file"
                type="file"
              />
            </label>
            <label className="service-file-input service-file-input--camera">
              <span>
                <FileImage aria-hidden="true" size={24} />
                <strong>{he ? "צילום במצלמה" : "Use camera"}</strong>
                <small>{he ? "לתמונות ראיה" : "For photo evidence"}</small>
              </span>
              <input
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                name="cameraFile"
                type="file"
              />
            </label>
          </div>
          {uploadProgress === undefined ? null : (
            <div className="service-upload-progress">
              <span style={{ inlineSize: `${String(uploadProgress)}%` }} />
              <small>{uploadProgress}%</small>
            </div>
          )}
          <div className="field-service-form__actions">
            <Button onClick={cancelUpload} type="button" variant="quiet">
              {he ? "ביטול" : "Cancel"}
            </Button>
            <Button
              busy={pendingAction === "upload-evidence"}
              disabled={pending}
              type="submit"
            >
              {pendingAction === "upload-evidence"
                ? he
                  ? "מעלה…"
                  : "Uploading…"
                : he
                  ? "העלאה"
                  : "Upload"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
