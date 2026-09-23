import type { InquiryFollowupAttention } from "@or-on/crm";

type Tone = "neutral" | "positive" | "warning" | "critical" | "info";

export const INQUIRY_COPY = {
  en: {
    emergencyFallback: "Emergency",
    emergencyOnly: "Emergencies only",
    attention: {
      not_requested: "No WhatsApp follow-up",
      pending: "WhatsApp follow-up pending",
      awaiting_customer: "Awaiting customer details/photo",
      customer_replied: "Customer replied",
      delivery_failed: "WhatsApp delivery failed",
      blocked: "WhatsApp follow-up not sent",
    } satisfies Record<InquiryFollowupAttention, string>,
    replyLinks: (count: number) =>
      `${String(count)} ${count === 1 ? "reply awaits" : "replies await"} linking`,
    nextActions: {
      complete_intake: "Complete the inquiry with the customer",
      dispatch: "Schedule and dispatch",
      urgent_callback: "Urgent callback",
      contact_customer: "Contact the customer",
    } as Readonly<Record<string, string>>,
    fields: {
      customerName: "Customer name",
      customerPhone: "Phone",
      callbackNumber: "Callback number",
      chainName: "Chain",
      storeName: "Branch",
      serviceAddress: "Service address",
      serviceLocation: "Service location",
      faultDescription: "Fault",
      exactFailure: "What exactly fails",
      productType: "Product",
      productModel: "Model",
      serialNumber: "Serial number",
      warrantyStatus: "Warranty",
      urgency: "Urgency",
    } as Readonly<Record<string, string>>,
    urgencies: {
      low: "Low",
      normal: "Normal",
      high: "High",
      urgent: "Urgent",
    } as Readonly<Record<string, string>>,
    followupStatuses: {
      not_requested: "Not requested",
      requested: "Requested — sent after the call",
      queued: "Queued",
      admitted: "Admitted for delivery",
      blocked_consent: "Blocked: no WhatsApp consent",
      blocked_window:
        "Blocked: outside the WhatsApp window and no approved template",
      no_channel: "Blocked: no active WhatsApp channel or sender",
      no_recipient: "Blocked: no verified caller number",
      recipient_conflict: "Blocked: the number belongs to another contact",
      failed: "Failed",
    } as Readonly<Record<string, string>>,
    messageStatuses: {
      pending: "Pending",
      queued: "Queued",
      sent: "Sent",
      delivered: "Delivered",
      read: "Read",
      failed: "Failed",
      received: "Received",
    } as Readonly<Record<string, string>>,
  },
  he: {
    emergencyFallback: "חירום",
    emergencyOnly: "רק קריאות חירום",
    attention: {
      not_requested: "ללא מעקב WhatsApp",
      pending: "מעקב WhatsApp ממתין לשליחה",
      awaiting_customer: "ממתין לפרטים/תמונה מהלקוח",
      customer_replied: "הלקוח השיב",
      delivery_failed: "שליחת WhatsApp נכשלה",
      blocked: "הודעת WhatsApp לא נשלחה",
    } satisfies Record<InquiryFollowupAttention, string>,
    replyLinks: (count: number) =>
      count === 1
        ? "תשובה אחת ממתינה לשיוך"
        : `${String(count)} תשובות ממתינות לשיוך`,
    nextActions: {
      complete_intake: "להשלים את הפנייה מול הלקוח",
      dispatch: "לתאם ולשבץ טכנאי",
      urgent_callback: "לחזור ללקוח בדחיפות",
      contact_customer: "ליצור קשר עם הלקוח",
    } as Readonly<Record<string, string>>,
    fields: {
      customerName: "שם הלקוח",
      customerPhone: "טלפון",
      callbackNumber: "מספר לחזרה",
      chainName: "רשת",
      storeName: "סניף",
      serviceAddress: "כתובת לשירות",
      serviceLocation: "מיקום השירות",
      faultDescription: "תקלה",
      exactFailure: "מה בדיוק לא עובד",
      productType: "מוצר",
      productModel: "דגם",
      serialNumber: "מספר סידורי",
      warrantyStatus: "אחריות",
      urgency: "דחיפות",
    } as Readonly<Record<string, string>>,
    urgencies: {
      low: "נמוכה",
      normal: "רגילה",
      high: "גבוהה",
      urgent: "דחופה",
    } as Readonly<Record<string, string>>,
    followupStatuses: {
      not_requested: "לא התבקש",
      requested: "התבקש — יישלח בסיום השיחה",
      queued: "בתור לשליחה",
      admitted: "נמסר לשליחה",
      blocked_consent: "לא נשלח: אין הסכמה ל-WhatsApp",
      blocked_window: "לא נשלח: מחוץ לחלון השירות ואין תבנית מאושרת",
      no_channel: "לא נשלח: אין ערוץ WhatsApp פעיל או שולח מורשה",
      no_recipient: "לא נשלח: אין מספר מתקשר מאומת",
      recipient_conflict: "לא נשלח: המספר שייך לאיש קשר אחר",
      failed: "נכשל",
    } as Readonly<Record<string, string>>,
    messageStatuses: {
      pending: "ממתינה",
      queued: "בתור",
      sent: "נשלחה",
      delivered: "נמסרה",
      read: "נקראה",
      failed: "נכשלה",
      received: "התקבלה",
    } as Readonly<Record<string, string>>,
  },
} as const;

export type InquiryCopy =
  (typeof INQUIRY_COPY)["en"] | (typeof INQUIRY_COPY)["he"];

export function inquiryCopy(locale: string): InquiryCopy {
  return INQUIRY_COPY[locale.startsWith("he") ? "he" : "en"];
}

export function attentionTone(attention: InquiryFollowupAttention): Tone {
  if (attention === "delivery_failed" || attention === "blocked")
    return "critical";
  if (attention === "awaiting_customer" || attention === "pending")
    return "warning";
  if (attention === "customer_replied") return "info";
  return "neutral";
}

export function nextActionLabel(
  copy: InquiryCopy,
  value: string | null,
): string | null {
  if (value === null) return null;
  return copy.nextActions[value] ?? value;
}
