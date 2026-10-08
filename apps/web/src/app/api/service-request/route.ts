import { NextResponse } from "next/server";
import {
  markDigitalServiceFormOpened,
  readDigitalServiceForm,
  submitDigitalServiceForm,
} from "@or-on/crm";
import { boundedMultipart } from "../../../features/uploads";
import { crmErrorResponse } from "../../../features/crm-route";
import {
  assertServiceFormOrigin,
  serviceFormIdentity,
  withServiceForm,
} from "../../../features/digital-service-form-server";
import {
  stagePrivateObject,
  commitPrivateObject,
  discardPrivateObject,
  type StagedPrivateObject,
} from "../../../features/private-objects";

export const runtime = "nodejs";
const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function unavailable(): never {
  throw Object.assign(new Error("Service form unavailable"), { code: "P0002" });
}

function errorResponse(error: unknown) {
  const classified = crmErrorResponse(error);
  const message =
    classified.status === 404
      ? "הקישור אינו זמין או שפג תוקפו. יש לבקש קישור חדש."
      : classified.status >= 500
        ? "לא הצלחנו לשמור את הפנייה כרגע. נסו שוב."
        : classified.status === 403
          ? "אין אפשרות לבצע את הפעולה באמצעות הקישור הזה."
          : "יש לבדוק את הפרטים והתמונות ולאשר את ההגשה.";
  const response = NextResponse.json(
    { error: message },
    { status: classified.status },
  );
  for (const [name, value] of Object.entries(headers))
    response.headers.set(name, value);
  return response;
}

export async function GET(request: Request) {
  try {
    const identity = serviceFormIdentity(request);
    const form = await withServiceForm(identity.tenant, async (sql) => {
      const result = await readDigitalServiceForm(sql, identity.token);
      if (result !== null)
        await markDigitalServiceFormOpened(sql, identity.token);
      return result;
    });
    if (form === null) unavailable();
    return NextResponse.json(
      {
        businessName: form.businessName,
        businessPhone: form.businessPhone,
        formVersion: form.formVersion ?? 1,
        customerName: form.customerName,
        faultDescription: form.faultDescription,
        photoRequired: form.photoRequired,
        submitted: form.submitted,
        reference: form.reference,
      },
      { headers },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function field(form: FormData, key: string, maximum: number): string {
  const entries = form.getAll(key);
  const value = entries[0];
  if (
    entries.length !== 1 ||
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > maximum
  )
    throw new TypeError("Complete the name, location and fault description");
  return value.trim();
}

export async function POST(request: Request) {
  const staged: StagedPrivateObject[] = [];
  let committed = false;
  const persistence = { promotedCreatedReceipt: false };
  let identity: ReturnType<typeof serviceFormIdentity> | undefined;
  try {
    assertServiceFormOrigin(request);
    identity = serviceFormIdentity(request);
    const authorized = identity;
    // Reject unknown/expired capabilities before buffering any upload.
    const existing = await withServiceForm(authorized.tenant, (sql) =>
      readDigitalServiceForm(sql, authorized.token),
    );
    if (existing === null) unavailable();
    if (existing.submitted)
      return NextResponse.json(
        { reference: existing.reference, created: false },
        { headers },
      );
    const form = await boundedMultipart(request, 20 * 1024 * 1024 + 64 * 1024);
    const customerName = field(form, "customerName", 160);
    const version = form.get("formVersion");
    if (
      form.getAll("formVersion").length > 1 ||
      (version !== null && version !== "2")
    )
      throw new TypeError("Invalid form version");
    if (existing.formVersion === 2 && version !== "2")
      throw new TypeError("Street and city required");
    const address =
      version === "2"
        ? {
            serviceStreet: field(form, "serviceStreet", 350),
            serviceCity: field(form, "serviceCity", 120),
          }
        : undefined;
    const serviceLocation = address
      ? `${address.serviceStreet}, ${address.serviceCity}`
      : field(form, "serviceLocation", 500);
    const faultDescription = field(form, "faultDescription", 4000);
    if (
      form.getAll("confirmed").length !== 1 ||
      form.get("confirmed") !== "true"
    )
      throw new TypeError("Confirm submission before opening the service case");
    const files = form.getAll("photos");
    if (
      files.length > 5 ||
      (existing.photoRequired && files.length === 0) ||
      files.some(
        (file) =>
          !(file instanceof File) ||
          file.size === 0 ||
          file.size > 12 * 1024 * 1024 ||
          !["image/jpeg", "image/png", "image/webp"].includes(file.type),
      )
    )
      throw new TypeError("Upload up to five JPEG, PNG or WebP photos");
    if (
      files.reduce(
        (sum, file) => sum + (file instanceof File ? file.size : 0),
        0,
      ) >
      20 * 1024 * 1024
    )
      throw new TypeError("Photos must total at most 20 MB");
    for (const file of files) {
      if (!(file instanceof File)) throw new TypeError("Invalid photo");
      staged.push(
        await stagePrivateObject({
          tenantId: authorized.tenant,
          caseId: existing.intakeId,
          category: "customer_photo",
          declaredContentType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        }),
      );
    }
    const receipt = await withServiceForm(authorized.tenant, async (sql) => {
      const result = await submitDigitalServiceForm(sql, authorized.token, {
        customerName,
        serviceLocation,
        ...address,
        faultDescription,
        confirmed: true,
        photos: staged,
      });
      if (result.created) {
        for (const object of staged) await commitPrivateObject(object);
        // A disconnect while COMMIT is acknowledged has an unknown outcome.
        // Once every promotion completes, these files may already be referenced.
        persistence.promotedCreatedReceipt = true;
      }
      return result;
    });
    committed = receipt.created;
    return NextResponse.json(receipt, {
      status: receipt.created ? 201 : 200,
      headers,
    });
  } catch (error) {
    if (persistence.promotedCreatedReceipt && identity) {
      const authorized = identity;
      const observed = await withServiceForm(authorized.tenant, (sql) =>
        readDigitalServiceForm(sql, authorized.token),
      ).catch(() => null);
      if (observed?.submitted && observed.reference)
        return NextResponse.json(
          { reference: observed.reference, created: false },
          { headers },
        );
      // A fresh negative read cannot establish rollback while the original
      // connection is settling. Preserve private files for reconciliation.
    }
    return errorResponse(error);
  } finally {
    if (!committed && !persistence.promotedCreatedReceipt)
      await Promise.all(
        staged.map((object) =>
          discardPrivateObject(object).catch(() => undefined),
        ),
      );
  }
}
