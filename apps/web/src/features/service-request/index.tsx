"use client";

import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useLocale } from "next-intl";
import { Button, Input, Textarea } from "@or-on/ui";
import styles from "./service-request.module.css";

const maximumPhotos = 5;
const maximumBytes = 20 * 1024 * 1024;
const maximumPhotoBytes = 12 * 1024 * 1024;
const photoTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
interface LinkCredentials {
  tenant: string;
  token: string;
}
interface RequestDetails {
  businessName?: string;
  customerName: string;
  faultDescription: string;
  photoRequired: boolean;
  submitted: boolean;
  reference?: string;
}
const wording = {
  he: {
    eyebrow: "פרטי הפנייה שלכם",
    title: "פתיחת קריאת שירות",
    intro:
      "השלימו את הפרטים ובדקו אותם לפני השליחה. קריאת השירות תיפתח רק לאחר אישור ושליחת הטופס.",
    loading: "טוענים את פרטי הפנייה…",
    unavailable: "הקישור אינו זמין או שפג תוקפו. יש לבקש מבית העסק קישור חדש.",
    connection: "לא הצלחנו לטעון את הטופס. נסו שוב.",
    retry: "ניסיון נוסף",
    name: "שם מלא",
    fault: "תיאור התקלה",
    location: "מיקום התקלה",
    locationHint: "כתובת, שם המקום ופרטים שיעזרו להגיע אליו",
    photos: "תמונות התקלה",
    photosHint:
      "עד 5 תמונות מסוג JPEG, PNG או WebP. עד 12 MB לתמונה ו-20 MB בסך הכול.",
    requiredPhoto: "יש לצרף לפחות תמונה אחת.",
    invalidPhotos:
      "יש לבחור עד 5 תמונות JPEG, PNG או WebP, עד 12 MB לתמונה ו-20 MB בסך הכול.",
    missing: "יש למלא שם, תיאור תקלה ומיקום, ולאשר את הפרטים לפני השליחה.",
    confirm: "בדקתי את הפרטים ואני מאשר/ת לשלוח את הפנייה ולפתוח קריאת שירות.",
    submit: "שליחת הפנייה",
    sending: "שולחים את הפנייה…",
    failed:
      "לא הצלחנו לאשר שהפנייה נשמרה. הפרטים נשארו כאן; אפשר לנסות שוב. ניסיון נוסף לא יפתח קריאה כפולה.",
    invalid:
      "הפרטים או התמונות לא התקבלו. בדקו אותם ונסו שוב; הטיוטה נשמרה כאן.",
    success: "הפנייה התקבלה",
    successDetail: "קריאת השירות נפתחה. אין צורך לשלוח שוב את הטופס.",
    reference: "מספר הפנייה",
  },
  en: {
    eyebrow: "Your request details",
    title: "Request service",
    intro:
      "Complete and review the details below. A service case opens only after you confirm and submit this form.",
    loading: "Loading your request…",
    unavailable:
      "This link is unavailable or expired. Ask the business for a new link.",
    connection: "We could not load the form. Please try again.",
    retry: "Try again",
    name: "Full name",
    fault: "Fault description",
    location: "Fault location",
    locationHint: "Address, place name and details to help us find it",
    photos: "Fault photos",
    photosHint:
      "Up to 5 JPEG, PNG or WebP photos, up to 12 MB each and 20 MB in total.",
    requiredPhoto: "Attach at least one photo.",
    invalidPhotos:
      "Choose up to 5 JPEG, PNG or WebP photos, up to 12 MB each and 20 MB in total.",
    missing:
      "Enter your name, fault description and location, then confirm the details before submitting.",
    confirm:
      "I have reviewed these details and confirm submitting this request to open a service case.",
    submit: "Submit request",
    sending: "Submitting your request…",
    failed:
      "We could not confirm that your request was saved. Your details are still here; you can try again. Retrying will not create a duplicate case.",
    invalid:
      "The details or photos were not accepted. Review them and try again; your draft is still here.",
    success: "Request received",
    successDetail:
      "Your service case has been opened. You do not need to submit this form again.",
    reference: "Request reference",
  },
} as const;

function readLink(): LinkCredentials | undefined {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const tenant = fragment.get("tenant"),
    token = fragment.get("token");
  if (
    fragment.getAll("tenant").length !== 1 ||
    fragment.getAll("token").length !== 1 ||
    !tenant ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(tenant) ||
    !token ||
    !/^[0-9a-f]{64}$/iu.test(token)
  )
    return undefined;
  return { tenant, token };
}
function requestHeaders(credentials: LinkCredentials) {
  return {
    Authorization: `Bearer ${credentials.token}`,
    "X-Service-Tenant": credentials.tenant,
  };
}
function readDetails(value: unknown): RequestDetails {
  if (
    value === null ||
    typeof value !== "object" ||
    ("businessName" in value && typeof value.businessName !== "string") ||
    !("customerName" in value) ||
    typeof value.customerName !== "string" ||
    !("faultDescription" in value) ||
    typeof value.faultDescription !== "string" ||
    !("photoRequired" in value) ||
    typeof value.photoRequired !== "boolean" ||
    !("submitted" in value) ||
    typeof value.submitted !== "boolean" ||
    ("reference" in value &&
      value.reference !== null &&
      value.reference !== undefined &&
      typeof value.reference !== "string")
  )
    throw new Error("Invalid response");
  return {
    ...("businessName" in value && typeof value.businessName === "string"
      ? { businessName: value.businessName }
      : {}),
    customerName: value.customerName,
    faultDescription: value.faultDescription,
    photoRequired: value.photoRequired,
    submitted: value.submitted,
    ...("reference" in value && typeof value.reference === "string"
      ? { reference: value.reference }
      : {}),
  };
}

export function ServiceRequestForm() {
  const he = useLocale().startsWith("he"),
    copy = he ? wording.he : wording.en;
  const credentials = useRef<LinkCredentials | undefined>(undefined);
  const sending = useRef(false);
  const [reload, setReload] = useState(0);
  const [details, setDetails] = useState<RequestDetails>();
  const [loadState, setLoadState] = useState<
    "loading" | "ready" | "unavailable" | "failed"
  >("loading");
  const [error, setError] = useState<
    "missing" | "requiredPhoto" | "invalidPhotos" | "failed" | "invalid"
  >();
  const [pending, setPending] = useState(false);
  const [photos, setPhotos] = useState<File[]>([]);
  const [name, setName] = useState(""),
    [fault, setFault] = useState(""),
    [location, setLocation] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const changeLink = () => {
      credentials.current = undefined;
      setLoadState("loading");
      setReload((value) => value + 1);
    };
    window.addEventListener("hashchange", changeLink);
    return () => window.removeEventListener("hashchange", changeLink);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const link = readLink();
    credentials.current = link;
    sending.current = false;
    setPending(false);
    setDetails(undefined);
    setName("");
    setFault("");
    setLocation("");
    setPhotos([]);
    setConfirmed(false);
    setError(undefined);
    setLoadState(link ? "loading" : "unavailable");
    if (!link) return () => controller.abort();
    void (async () => {
      try {
        const response = await fetch("/api/service-request", {
          headers: requestHeaders(link),
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (response.status === 404) {
          setLoadState("unavailable");
          return;
        }
        if (!response.ok) throw new Error("Unavailable");
        const loaded = readDetails(await response.json());
        controller.signal.throwIfAborted();
        setDetails(loaded);
        setName(loaded.customerName);
        setFault(loaded.faultDescription);
        setLoadState("ready");
      } catch {
        if (!controller.signal.aborted) setLoadState("failed");
      }
    })();
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (details?.submitted) resultHeading.current?.focus();
  }, [details?.submitted]);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const link = credentials.current;
    if (!link || !details || details.submitted || sending.current) return;
    setError(undefined);
    if (
      !name.trim() ||
      name.trim().length > 160 ||
      !fault.trim() ||
      fault.trim().length > 4000 ||
      !location.trim() ||
      location.trim().length > 500 ||
      !confirmed
    ) {
      setError("missing");
      return;
    }
    if (
      photos.length > maximumPhotos ||
      photos.some(
        (file) =>
          file.size === 0 ||
          file.size > maximumPhotoBytes ||
          !photoTypes.has(file.type),
      ) ||
      photos.reduce((sum, file) => sum + file.size, 0) > maximumBytes
    ) {
      setError("invalidPhotos");
      return;
    }
    if (details.photoRequired && photos.length === 0) {
      setError("requiredPhoto");
      return;
    }
    const body = new FormData();
    body.set("customerName", name.trim());
    body.set("faultDescription", fault.trim());
    body.set("serviceLocation", location.trim());
    body.set("confirmed", "true");
    for (const file of photos) body.append("photos", file);
    sending.current = true;
    setPending(true);
    try {
      const response = await fetch("/api/service-request", {
        method: "POST",
        headers: requestHeaders(link),
        body,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (credentials.current !== link) return;
      if (response.status === 404) {
        setLoadState("unavailable");
        return;
      }
      if (response.status === 400) {
        setError("invalid");
        return;
      }
      if (!response.ok) throw new Error("Unavailable");
      const result: unknown = await response.json();
      if (credentials.current !== link) return;
      if (
        result === null ||
        typeof result !== "object" ||
        !("reference" in result) ||
        typeof result.reference !== "string" ||
        !result.reference
      )
        throw new Error("Invalid receipt");
      setDetails({ ...details, submitted: true, reference: result.reference });
      setPhotos([]);
    } catch {
      if (credentials.current === link) setError("failed");
    } finally {
      if (credentials.current === link) {
        sending.current = false;
        setPending(false);
      }
    }
  }

  return (
    <main className={styles.page} dir={he ? "rtl" : "ltr"}>
      <section className={styles.card} aria-labelledby="service-request-title">
        <header>
          <p className={styles.eyebrow}>
            {details?.businessName ?? copy.eyebrow}
          </p>
          <h1 id="service-request-title">{copy.title}</h1>
        </header>
        {loadState === "loading" ? (
          <p role="status">{copy.loading}</p>
        ) : loadState === "unavailable" ? (
          <p role="alert">{copy.unavailable}</p>
        ) : loadState === "failed" ? (
          <>
            <p role="alert">{copy.connection}</p>
            <Button onClick={() => setReload((value) => value + 1)}>
              {copy.retry}
            </Button>
          </>
        ) : details?.submitted ? (
          <div className={styles.receipt} role="status">
            <h2 ref={resultHeading} tabIndex={-1}>
              {copy.success}
            </h2>
            <p>{copy.successDetail}</p>
            {details.reference ? (
              <p>
                {copy.reference}: <bdi>{details.reference}</bdi>
              </p>
            ) : null}
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <p className={styles.intro}>{copy.intro}</p>
            <fieldset className={styles.fields} disabled={pending}>
              <Input
                id="service-customer-name"
                label={copy.name}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={160}
                required
                autoComplete="name"
                dir="auto"
              />
              <Textarea
                id="service-fault"
                label={copy.fault}
                value={fault}
                onChange={(event) => setFault(event.target.value)}
                maxLength={4000}
                rows={4}
                required
                dir="auto"
              />
              <Textarea
                id="service-location"
                label={copy.location}
                hint={copy.locationHint}
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                maxLength={500}
                rows={3}
                required
                autoComplete="street-address"
                dir="auto"
              />
              <div className={styles.upload}>
                <label htmlFor="service-photos">
                  {copy.photos}
                  {details?.photoRequired ? " *" : ""}
                </label>
                <p id="service-photos-hint">
                  {copy.photosHint}
                  {details?.photoRequired ? ` ${copy.requiredPhoto}` : ""}
                </p>
                <input
                  id="service-photos"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  aria-required={details?.photoRequired === true}
                  aria-describedby="service-photos-hint"
                  onChange={(event) => {
                    setPhotos(Array.from(event.target.files ?? []));
                    setError(undefined);
                  }}
                />
                {photos.length ? (
                  <ul>
                    {photos.map((file, index) => (
                      <li key={`${String(index)}:${file.name}`} dir="auto">
                        {file.name}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <label className={styles.confirm}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  required
                />
                <span>{copy.confirm}</span>
              </label>
              {error ? (
                <p className={styles.error} role="alert">
                  {copy[error]}
                </p>
              ) : null}
              <Button type="submit" busy={pending}>
                {pending ? copy.sending : copy.submit}
              </Button>
            </fieldset>
          </form>
        )}
      </section>
    </main>
  );
}
