"use client";

import type {
  AttachmentCategoryPolicy,
  EmergencyPolicy,
  EvidencePolicy,
  FollowUpTemplateParameter,
  PreparationPolicy,
  ServiceWorkflowPolicy,
  WhatsAppFollowUpPolicy,
} from "@or-on/crm/service-workflow";
import { Button, Input, Select, Textarea } from "@or-on/ui";

import styles from "./business-configuration.module.css";

type OptionalKey =
  | "inquiry"
  | "whatsappFollowUp"
  | "emergency"
  | "preparation"
  | "attachmentCategories"
  | "evidence";

const defaults = {
  whatsappFollowUp: {
    enabled: true,
    trigger: "call_ended",
    requestPhoto: true,
    consent: "in_call_agreement",
  } satisfies WhatsAppFollowUpPolicy,
  emergency: {
    enabled: true,
    label: "",
    manualRedCall: true,
    fallback: "urgent_followup",
  } satisfies EmergencyPolicy,
  preparation: {
    enabled: true,
    requireAcknowledgement: true,
    checklist: [],
  } satisfies PreparationPolicy,
  evidence: {
    beforePhotoRequired: true,
    afterPhotoRequired: true,
  } satisfies EvidencePolicy,
};

/** A copy without the named optional keys. */
function without<T extends object>(value: T, ...keys: readonly string[]): T {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  ) as T;
}

const templateParameters: readonly (readonly [
  FollowUpTemplateParameter,
  string,
  string,
])[] = [
  ["customerName", "Customer name", "שם הלקוח"],
  ["reference", "Inquiry reference", "מספר הפנייה"],
  ["faultSummary", "Fault summary", "תקציר התקלה"],
  ["businessName", "Business name", "שם העסק"],
];

/**
 * Optional field-operation capabilities. Every change edits the draft only;
 * activation still requires submission and platform approval, and the server
 * validates the same rules again. Security boundaries are not settings here.
 */
export function FieldOperationsSettings({
  workflow,
  locked,
  he,
  onChange,
}: {
  readonly workflow: ServiceWorkflowPolicy;
  readonly locked: boolean;
  readonly he: boolean;
  readonly onChange: (key: OptionalKey, value: unknown) => void;
}) {
  const copy = (en: string, hebrew: string) => (he ? hebrew : en);
  const followUp = workflow.whatsappFollowUp;
  const emergency = workflow.emergency;
  const preparation = workflow.preparation;
  const categories = workflow.attachmentCategories ?? [];
  const evidence = workflow.evidence;

  return (
    <div className={styles.policyGrid}>
      <fieldset className={styles.fieldset} disabled={locked}>
        <legend>{copy("Phone inquiries", "פניות טלפוניות")}</legend>
        <label className={styles.check}>
          <input
            checked={workflow.inquiry?.openOnFirstContact === true}
            onChange={(event) =>
              onChange(
                "inquiry",
                event.target.checked ? { openOnFirstContact: true } : undefined,
              )
            }
            type="checkbox"
          />
          <span>
            {copy(
              "Show an inquiry in the inbox as soon as a call starts, and keep incomplete calls visible for follow-up",
              "להציג פנייה בתיבת הפניות מרגע תחילת השיחה, ולהשאיר שיחות שלא הושלמו גלויות להמשך טיפול",
            )}
          </span>
        </label>
      </fieldset>

      <fieldset className={styles.fieldset} disabled={locked}>
        <legend>{copy("WhatsApp follow-up", "מעקב WhatsApp")}</legend>
        <label className={styles.check}>
          <input
            checked={followUp?.enabled === true}
            onChange={(event) =>
              onChange(
                "whatsappFollowUp",
                event.target.checked
                  ? { ...defaults.whatsappFollowUp, ...followUp, enabled: true }
                  : undefined,
              )
            }
            type="checkbox"
          />
          <span>
            {copy(
              "Send the caller a WhatsApp summary written by the system, asking for a fault photo and missing details",
              "לשלוח למתקשר סיכום ב-WhatsApp שנכתב על ידי המערכת, ובו בקשה לתמונת התקלה ולפרטים חסרים",
            )}
          </span>
        </label>
        {followUp?.enabled === true ? (
          <>
            <Select
              id="followup-trigger"
              label={copy("When to send", "מתי לשלוח")}
              onChange={(event) =>
                onChange("whatsappFollowUp", {
                  ...followUp,
                  trigger: event.target.value,
                })
              }
              value={followUp.trigger}
            >
              <option value="call_ended">
                {copy(
                  "After the call ends (complete summary)",
                  "בסיום השיחה (סיכום מלא)",
                )}
              </option>
              <option value="intake_saved">
                {copy("As soon as the caller agrees", "מיד כשהמתקשר מסכים")}
              </option>
            </Select>
            <Select
              id="followup-consent"
              label={copy("Consent", "הסכמה")}
              onChange={(event) =>
                onChange("whatsappFollowUp", {
                  ...followUp,
                  consent: event.target.value,
                })
              }
              value={followUp.consent}
            >
              <option value="in_call_agreement">
                {copy(
                  "The caller agrees during the call",
                  "המתקשר מסכים במהלך השיחה",
                )}
              </option>
              <option value="existing_only">
                {copy(
                  "Only customers who already consented",
                  "רק ללקוחות שכבר נתנו הסכמה",
                )}
              </option>
            </Select>
            <label className={styles.check}>
              <input
                checked={followUp.requestPhoto}
                onChange={(event) =>
                  onChange("whatsappFollowUp", {
                    ...followUp,
                    requestPhoto: event.target.checked,
                  })
                }
                type="checkbox"
              />
              <span>
                {copy("Ask for a photo of the fault", "לבקש תמונה של התקלה")}
              </span>
            </label>
            <Input
              id="followup-template"
              label={copy(
                "Approved template outside the 24-hour window (optional)",
                "תבנית מאושרת מחוץ לחלון 24 השעות (לא חובה)",
              )}
              onChange={(event) => {
                const name = event.target.value.trim();
                const rest = without(
                  followUp,
                  "templateName",
                  "templateLanguage",
                  "templateParameters",
                );
                onChange(
                  "whatsappFollowUp",
                  name === ""
                    ? rest
                    : {
                        ...rest,
                        templateName: name,
                        templateLanguage:
                          followUp.templateLanguage ?? (he ? "he" : "en"),
                        templateParameters: followUp.templateParameters ?? [],
                      },
                );
              }}
              value={followUp.templateName ?? ""}
            />
            {followUp.templateName === undefined ? null : (
              <>
                <Input
                  id="followup-template-language"
                  label={copy("Template language code", "קוד שפת התבנית")}
                  onChange={(event) =>
                    onChange("whatsappFollowUp", {
                      ...followUp,
                      templateLanguage: event.target.value.trim(),
                    })
                  }
                  value={followUp.templateLanguage ?? ""}
                />
                <p>
                  {copy(
                    "Template parameters, in order",
                    "פרמטרים לתבנית, לפי הסדר",
                  )}
                </p>
                {templateParameters.map(([key, en, hebrew]) => (
                  <label className={styles.check} key={key}>
                    <input
                      checked={(followUp.templateParameters ?? []).includes(
                        key,
                      )}
                      onChange={(event) => {
                        const current = followUp.templateParameters ?? [];
                        onChange("whatsappFollowUp", {
                          ...followUp,
                          templateParameters: event.target.checked
                            ? [...current, key]
                            : current.filter((item) => item !== key),
                        });
                      }}
                      type="checkbox"
                    />
                    <span>{copy(en, hebrew)}</span>
                  </label>
                ))}
              </>
            )}
          </>
        ) : null}
      </fieldset>

      <fieldset className={styles.fieldset} disabled={locked}>
        <legend>{copy("Emergencies", "קריאות חירום")}</legend>
        <label className={styles.check}>
          <input
            checked={emergency?.enabled === true}
            onChange={(event) =>
              onChange(
                "emergency",
                event.target.checked
                  ? {
                      ...defaults.emergency,
                      label: he ? "קריאה אדומה" : "Red call",
                      ...emergency,
                      enabled: true,
                    }
                  : undefined,
              )
            }
            type="checkbox"
          />
          <span>
            {copy(
              "Handle emergencies as urgent inquiries with escalation",
              "לטפל במקרי חירום כפניות דחופות עם הסלמה",
            )}
          </span>
        </label>
        {emergency?.enabled === true ? (
          <>
            <Input
              id="emergency-label"
              label={copy("Label shown to staff", "התווית שמוצגת לצוות")}
              maxLength={40}
              onChange={(event) =>
                onChange("emergency", {
                  ...emergency,
                  label: event.target.value,
                })
              }
              value={emergency.label}
            />
            <label className={styles.check}>
              <input
                checked={emergency.manualRedCall}
                onChange={(event) =>
                  onChange("emergency", {
                    ...emergency,
                    manualRedCall: event.target.checked,
                  })
                }
                type="checkbox"
              />
              <span>
                {copy(
                  "Owners and dispatchers can mark an inquiry manually",
                  "בעלים ומשבצים יכולים לסמן פנייה ידנית",
                )}
              </span>
            </label>
            <Input
              dir="ltr"
              id="emergency-transfer"
              inputMode="tel"
              label={copy(
                "On-call number for live transfer (E.164, optional, never shown to callers or the AI)",
                "מספר תורן להעברת שיחה (בפורמט בינלאומי, לא חובה, לא מוצג למתקשרים או ל-AI)",
              )}
              onChange={(event) => {
                const value = event.target.value.trim();
                const rest = without(emergency, "transferTo");
                onChange(
                  "emergency",
                  value === "" ? rest : { ...rest, transferTo: value },
                );
              }}
              placeholder="+972501234567"
              value={emergency.transferTo ?? ""}
            />
            <Select
              id="emergency-fallback"
              label={copy(
                "If the transfer fails or no one is configured",
                "אם ההעברה נכשלת או שלא הוגדר תורן",
              )}
              onChange={(event) =>
                onChange("emergency", {
                  ...emergency,
                  fallback: event.target.value,
                })
              }
              value={emergency.fallback}
            >
              <option value="urgent_followup">
                {copy("Leave an urgent follow-up", "להשאיר משימת חזרה דחופה")}
              </option>
              <option value="notify_staff">
                {copy("Leave it and notify staff", "להשאיר ולהתריע לצוות")}
              </option>
            </Select>
          </>
        ) : null}
      </fieldset>

      <fieldset className={styles.fieldset} disabled={locked}>
        <legend>{copy("Technician preparation", "הצטיידות טכנאי")}</legend>
        <label className={styles.check}>
          <input
            checked={preparation?.enabled === true}
            onChange={(event) =>
              onChange(
                "preparation",
                event.target.checked
                  ? { ...defaults.preparation, ...preparation, enabled: true }
                  : undefined,
              )
            }
            type="checkbox"
          />
          <span>
            {copy(
              "Show a preparation checklist before the technician departs",
              "להציג רשימת הצטיידות לפני שהטכנאי יוצא לדרך",
            )}
          </span>
        </label>
        {preparation?.enabled === true ? (
          <>
            <label className={styles.check}>
              <input
                checked={preparation.requireAcknowledgement}
                onChange={(event) =>
                  onChange("preparation", {
                    ...preparation,
                    requireAcknowledgement: event.target.checked,
                  })
                }
                type="checkbox"
              />
              <span>
                {copy(
                  "Require acknowledgement before departure",
                  "לחייב אישור לפני יציאה לדרך",
                )}
              </span>
            </label>
            <Textarea
              id="preparation-instructions"
              label={copy("Instructions", "הנחיות")}
              maxLength={2000}
              onChange={(event) => {
                const value = event.target.value;
                const rest = without(preparation, "instructions");
                onChange(
                  "preparation",
                  value.trim() === "" ? rest : { ...rest, instructions: value },
                );
              }}
              value={preparation.instructions ?? ""}
            />
            {preparation.checklist.map((item, index) => (
              <div className={styles.inlineRow} key={item.key}>
                <Input
                  id={`preparation-item-${item.key}`}
                  label={copy("Item", "פריט")}
                  onChange={(event) =>
                    onChange("preparation", {
                      ...preparation,
                      checklist: preparation.checklist.map((entry, position) =>
                        position === index
                          ? { ...entry, label: event.target.value }
                          : entry,
                      ),
                    })
                  }
                  value={item.label}
                />
                <label className={styles.check}>
                  <input
                    checked={item.required}
                    onChange={(event) =>
                      onChange("preparation", {
                        ...preparation,
                        checklist: preparation.checklist.map(
                          (entry, position) =>
                            position === index
                              ? { ...entry, required: event.target.checked }
                              : entry,
                        ),
                      })
                    }
                    type="checkbox"
                  />
                  <span>{copy("Required", "חובה")}</span>
                </label>
                <Button
                  onClick={() =>
                    onChange("preparation", {
                      ...preparation,
                      checklist: preparation.checklist.filter(
                        (_, position) => position !== index,
                      ),
                    })
                  }
                  type="button"
                  variant="quiet"
                >
                  {copy("Remove", "הסרה")}
                </Button>
              </div>
            ))}
            <Button
              disabled={preparation.checklist.length >= 30}
              onClick={() => {
                const used = new Set(
                  preparation.checklist.map((item) => item.key),
                );
                let next = preparation.checklist.length + 1;
                while (used.has(`item_${String(next)}`)) next += 1;
                onChange("preparation", {
                  ...preparation,
                  checklist: [
                    ...preparation.checklist,
                    { key: `item_${String(next)}`, label: "", required: true },
                  ],
                });
              }}
              type="button"
              variant="secondary"
            >
              {copy("Add checklist item", "הוספת פריט")}
            </Button>
          </>
        ) : null}
      </fieldset>

      <fieldset className={styles.fieldset} disabled={locked}>
        <legend>{copy("Technician documents", "מסמכי טכנאי")}</legend>
        <p>
          {copy(
            "Document types technicians can upload to a case and its report, such as RCG. Keys use lowercase Latin letters.",
            "סוגי מסמכים שטכנאים יכולים להעלות לקריאה ולדוח, למשל RCG. המפתח באותיות לטיניות קטנות.",
          )}
        </p>
        {categories.map((category: AttachmentCategoryPolicy, index) => (
          <div
            className={styles.inlineRow}
            key={`${category.key}-${String(index)}`}
          >
            <Input
              dir="ltr"
              id={`document-key-${String(index)}`}
              label={copy("Key", "מפתח")}
              onChange={(event) =>
                onChange(
                  "attachmentCategories",
                  categories.map((entry, position) =>
                    position === index
                      ? {
                          ...entry,
                          key: event.target.value.trim().toLowerCase(),
                        }
                      : entry,
                  ),
                )
              }
              value={category.key}
            />
            <Input
              id={`document-label-${String(index)}`}
              label={copy("Label", "שם")}
              onChange={(event) =>
                onChange(
                  "attachmentCategories",
                  categories.map((entry, position) =>
                    position === index
                      ? { ...entry, label: event.target.value }
                      : entry,
                  ),
                )
              }
              value={category.label}
            />
            {(["pdf", "image"] as const).map((kind) => (
              <label className={styles.check} key={kind}>
                <input
                  checked={category.accept.includes(kind)}
                  onChange={(event) =>
                    onChange(
                      "attachmentCategories",
                      categories.map((entry, position) =>
                        position === index
                          ? {
                              ...entry,
                              accept: event.target.checked
                                ? [...entry.accept, kind]
                                : entry.accept.filter((item) => item !== kind),
                            }
                          : entry,
                      ),
                    )
                  }
                  type="checkbox"
                />
                <span>{kind === "pdf" ? "PDF" : copy("Image", "תמונה")}</span>
              </label>
            ))}
            <Button
              onClick={() => {
                const next = categories.filter(
                  (_, position) => position !== index,
                );
                onChange(
                  "attachmentCategories",
                  next.length === 0 ? undefined : next,
                );
              }}
              type="button"
              variant="quiet"
            >
              {copy("Remove", "הסרה")}
            </Button>
          </div>
        ))}
        <Button
          disabled={categories.length >= 12}
          onClick={() =>
            onChange("attachmentCategories", [
              ...categories,
              { key: "", label: "", accept: ["pdf", "image"] },
            ])
          }
          type="button"
          variant="secondary"
        >
          {copy("Add document type", "הוספת סוג מסמך")}
        </Button>
      </fieldset>

      <fieldset className={styles.fieldset} disabled={locked}>
        <legend>{copy("Completion evidence", "תיעוד לפני ואחרי")}</legend>
        {(
          [
            [
              "beforePhotoRequired",
              "Require a before photo before work starts",
              "לחייב תמונת לפני לפני תחילת העבודה",
            ],
            [
              "afterPhotoRequired",
              "Require an after photo before completion and report finalization",
              "לחייב תמונת אחרי לפני סיום העבודה וסגירת הדוח",
            ],
          ] as const
        ).map(([key, en, hebrew]) => (
          <label className={styles.check} key={key}>
            <input
              checked={evidence?.[key] === true}
              onChange={(event) => {
                const next = {
                  ...defaults.evidence,
                  ...evidence,
                  [key]: event.target.checked,
                };
                onChange(
                  "evidence",
                  next.beforePhotoRequired || next.afterPhotoRequired
                    ? next
                    : undefined,
                );
              }}
              type="checkbox"
            />
            <span>{copy(en, hebrew)}</span>
          </label>
        ))}
        <p>
          {copy(
            "Applies to cases opened after approval. Existing open cases keep the rules they were opened under, and completed cases are never reopened.",
            "חל על קריאות שנפתחות אחרי האישור. קריאות פתוחות קיימות שומרות על הכללים שבהם נפתחו, וקריאות שהושלמו אינן נפתחות מחדש.",
          )}
        </p>
      </fieldset>
    </div>
  );
}
