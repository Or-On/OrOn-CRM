import { NextResponse } from "next/server";
import {
  createServiceCase,
  createTechnicianServiceCase,
  listServiceCasePage,
  serviceCaseStatuses,
  type ServiceCaseStatus,
  type WarrantyStatus,
} from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { optionalText, text, uuid } from "../../../../features/field-service";

function status(value: string | null): ServiceCaseStatus | undefined {
  if (value === null) return undefined;
  if (!serviceCaseStatuses.includes(value as ServiceCaseStatus))
    throw new TypeError("Invalid service-case status");
  return value as ServiceCaseStatus;
}

function warranty(value: unknown): WarrantyStatus {
  if (value === undefined) return "unknown";
  if (value !== "unknown" && value !== "yes" && value !== "no")
    throw new TypeError("Warranty status must be unknown, yes, or no");
  return value;
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const selectedStatus = status(parameters.get("status"));
    const cursorAt = parameters.get("cursorAt") ?? undefined;
    const cursorId = parameters.get("cursorId") ?? undefined;
    if ((cursorAt === undefined) !== (cursorId === undefined))
      throw new TypeError("Both service-case cursor fields are required");
    if (cursorAt !== undefined && !Number.isFinite(Date.parse(cursorAt)))
      throw new TypeError("Service-case cursor is invalid");
    const requestedLimit = Number(parameters.get("limit") ?? "50");
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1)
      throw new TypeError("Service-case page limit is invalid");
    const page = await withCurrentTenant("field-service:read", (sql) =>
      listServiceCasePage(sql, {
        ...(selectedStatus === undefined ? {} : { status: selectedStatus }),
        query: parameters.get("q") ?? "",
        limit: requestedLimit,
        ...(cursorAt === undefined || cursorId === undefined
          ? {}
          : {
              cursor: {
                updatedAt: cursorAt,
                id: uuid(cursorId, "Case cursor"),
              },
            }),
      }),
    );
    return NextResponse.json(page);
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const priority = body.priority === undefined ? "normal" : body.priority;
    if (
      typeof priority !== "string" ||
      !["low", "normal", "high", "urgent"].includes(priority)
    )
      throw new TypeError("Invalid case priority");
    const productType = optionalText(body.productType, "Product type");
    const productModel = optionalText(body.productModel, "Product model");
    const serialNumber = optionalText(body.serialNumber, "Serial number");
    const details = {
      customerContactId: uuid(body.customerContactId, "Customer"),
      ...(body.serviceLocationId === undefined ||
      body.serviceLocationId === null
        ? {}
        : {
            serviceLocationId: uuid(body.serviceLocationId, "Service location"),
          }),
      title: text(body.title, "Case title"),
      faultDescription: text(body.faultDescription, "Fault description"),
      ...(typeof body.exactFailure === "string"
        ? { exactFailure: text(body.exactFailure, "What is not working") }
        : {}),
      warrantyStatus: warranty(body.warrantyStatus),
      ...(productType === undefined ? {} : { productType }),
      ...(productModel === undefined ? {} : { productModel }),
      ...(serialNumber === undefined ? {} : { serialNumber }),
      priority: priority as "low" | "normal" | "high" | "urgent",
    };
    const created = await withCurrentTenant(
      "field-service:operate",
      async (sql, session) => {
        if (session.tenant.role === "technician" && !session.isSuperuser) {
          // Field work belongs to the physical technician of this browser
          // session, resolved by PostgreSQL. The browser cannot name one.
          if (
            "technicianId" in body ||
            "assignedTechnicianId" in body ||
            "reportingContactId" in body
          )
            throw new TypeError(
              "A technician case is assigned to the technician signed in on this device",
            );
          const receipt = await createTechnicianServiceCase(sql, {
            ...details,
            requestId: requestId(request),
          });
          return {
            case: receipt.serviceCase,
            technicianId: receipt.technicianId,
            visitId: receipt.visitId,
          };
        }
        return {
          case: await createServiceCase(
            sql,
            { userId: session.userId },
            {
              ...details,
              ...(body.reportingContactId === undefined
                ? {}
                : {
                    reportingContactId: uuid(
                      body.reportingContactId,
                      "Reporting contact",
                    ),
                  }),
            },
          ),
        };
      },
    );
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
