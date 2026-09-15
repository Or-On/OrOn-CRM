import type {
  ReportRevision,
  ServiceAppointment,
  ServiceCaseSummary,
  ServiceCaseStatus,
  ServiceOcrSummary,
  ServiceVisit,
  TechnicianSummary,
  WarrantyStatus,
} from "@or-on/crm";

type FieldServiceLocale = "en" | "he";

const caseStatusLabels: Readonly<
  Record<ServiceCaseStatus, Readonly<Record<FieldServiceLocale, string>>>
> = {
  awaiting_scheduling: { en: "Awaiting scheduling", he: "ממתין לתזמון" },
  scheduled: { en: "Scheduled", he: "מתוזמן" },
  in_progress: { en: "In progress", he: "בטיפול" },
  completed: { en: "Completed", he: "הושלם" },
  closed: { en: "Closed", he: "נסגר" },
  cancelled: { en: "Cancelled", he: "בוטל" },
};

const warrantyLabels: Readonly<
  Record<WarrantyStatus, Readonly<Record<FieldServiceLocale, string>>>
> = {
  unknown: { en: "Unknown", he: "לא ידוע" },
  yes: { en: "Yes", he: "כן" },
  no: { en: "No", he: "לא" },
};

const ocrStatusLabels: Readonly<
  Record<
    ServiceOcrSummary["status"],
    Readonly<Record<FieldServiceLocale, string>>
  >
> = {
  pending: { en: "Waiting to process", he: "ממתין לעיבוד" },
  processing: { en: "Processing", he: "בעיבוד" },
  review_required: { en: "Review required", he: "נדרשת בדיקה" },
  confirmed: { en: "Confirmed", he: "אושר" },
  failed: { en: "Processing failed", he: "העיבוד נכשל" },
};

const appointmentStatusLabels: Readonly<
  Record<
    ServiceAppointment["status"],
    Readonly<Record<FieldServiceLocale, string>>
  >
> = {
  suggested: { en: "Suggested", he: "הוצע" },
  scheduled: { en: "Scheduled", he: "מתוזמן" },
  in_progress: { en: "In progress", he: "בביצוע" },
  completed: { en: "Completed", he: "הושלם" },
  cancelled: { en: "Cancelled", he: "בוטל" },
};

const visitStatusLabels: Readonly<
  Record<ServiceVisit["status"], Readonly<Record<FieldServiceLocale, string>>>
> = {
  assigned: { en: "Assigned", he: "הוקצה" },
  arrived: { en: "On site", he: "באתר" },
  departed: { en: "Visit completed", he: "הביקור הושלם" },
  reported: { en: "Report submitted", he: "הדוח הוגש" },
  cancelled: { en: "Cancelled", he: "בוטל" },
};

const reportStatusLabels: Readonly<
  Record<ReportRevision["status"], Readonly<Record<FieldServiceLocale, string>>>
> = {
  draft: { en: "Draft", he: "טיוטה" },
  review_required: { en: "Review required", he: "נדרשת בדיקה" },
  finalized: { en: "Finalized", he: "הושלם ונחתם" },
  superseded: { en: "Replaced by a newer version", he: "הוחלף בגרסה חדשה" },
};

const priorityLabels: Readonly<
  Record<
    ServiceCaseSummary["priority"],
    Readonly<Record<FieldServiceLocale, string>>
  >
> = {
  low: { en: "Low priority", he: "עדיפות נמוכה" },
  normal: { en: "Normal priority", he: "עדיפות רגילה" },
  high: { en: "High priority", he: "עדיפות גבוהה" },
  urgent: { en: "Urgent", he: "דחוף" },
};

const technicianIdentityLabels: Readonly<
  Record<
    TechnicianSummary["identityVerification"],
    Readonly<Record<FieldServiceLocale, string>>
  >
> = {
  self_declared: { en: "Self-declared", he: "הצהרה עצמית" },
  verified: { en: "Verified", he: "מאומת" },
  revoked: { en: "Verification revoked", he: "האימות בוטל" },
};

const evidenceCategoryLabels: Readonly<
  Record<string, Readonly<Record<FieldServiceLocale, string>>>
> = {
  fault: { en: "Fault photo", he: "צילום תקלה" },
  module: { en: "Module photo", he: "צילום מודול" },
  product_label: { en: "Product label", he: "תווית מוצר" },
  repair: { en: "Repair photo", he: "צילום תיקון" },
  environment: { en: "Environment photo", he: "צילום סביבת העבודה" },
  customer_photo: { en: "Customer photo", he: "צילום לקוח" },
  document: { en: "Document", he: "מסמך" },
  arrival_signature: { en: "Arrival signature", he: "חתימת הגעה" },
  departure_signature: { en: "Departure signature", he: "חתימת יציאה" },
};

const processingStatusLabels: Readonly<
  Record<string, Readonly<Record<FieldServiceLocale, string>>>
> = {
  pending: { en: "Pending", he: "ממתין" },
  processing: { en: "Processing", he: "בעיבוד" },
  available: { en: "Available", he: "זמין" },
  completed: { en: "Completed", he: "הושלם" },
  failed: { en: "Failed", he: "נכשל" },
  quarantined: { en: "Quarantined", he: "בהסגר" },
  deleted: { en: "Deleted", he: "נמחק" },
  missing: { en: "Unavailable", he: "לא זמין" },
};

function localeKey(hebrew: boolean): FieldServiceLocale {
  return hebrew ? "he" : "en";
}

function isServiceCaseStatus(value: string): value is ServiceCaseStatus {
  return Object.hasOwn(caseStatusLabels, value);
}

export function caseStatusLabel(status: string, hebrew: boolean): string {
  return isServiceCaseStatus(status)
    ? caseStatusLabels[status][localeKey(hebrew)]
    : readableFieldServiceValue(status);
}

export function warrantyStatusLabel(
  status: WarrantyStatus,
  hebrew: boolean,
): string {
  return warrantyLabels[status][localeKey(hebrew)];
}

export function ocrStatusLabel(
  status: ServiceOcrSummary["status"],
  hebrew: boolean,
): string {
  return ocrStatusLabels[status][localeKey(hebrew)];
}

export function appointmentStatusLabel(
  status: ServiceAppointment["status"],
  hebrew: boolean,
): string {
  return appointmentStatusLabels[status][localeKey(hebrew)];
}

export function visitStatusLabel(
  status: ServiceVisit["status"],
  hebrew: boolean,
): string {
  return visitStatusLabels[status][localeKey(hebrew)];
}

export function reportStatusLabel(
  status: ReportRevision["status"],
  hebrew: boolean,
): string {
  return reportStatusLabels[status][localeKey(hebrew)];
}

export function casePriorityLabel(
  priority: ServiceCaseSummary["priority"],
  hebrew: boolean,
): string {
  return priorityLabels[priority][localeKey(hebrew)];
}

export function technicianIdentityLabel(
  status: TechnicianSummary["identityVerification"],
  hebrew: boolean,
): string {
  return technicianIdentityLabels[status][localeKey(hebrew)];
}

export function evidenceCategoryLabel(
  category: string,
  hebrew: boolean,
): string {
  return (
    evidenceCategoryLabels[category]?.[localeKey(hebrew)] ??
    readableFieldServiceValue(category)
  );
}

export function processingStatusLabel(status: string, hebrew: boolean): string {
  return (
    processingStatusLabels[status]?.[localeKey(hebrew)] ??
    readableFieldServiceValue(status)
  );
}

export function readableFieldServiceValue(value: string): string {
  const words = value.trim().replaceAll("_", " ");
  return words.length === 0
    ? words
    : `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}`;
}
