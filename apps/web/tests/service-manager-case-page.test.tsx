import { describe, expect, it, vi } from "vitest";
import type * as CrmModule from "@or-on/crm";
import { renderMarkup } from "./localized";

const state = vi.hoisted(() => ({ experience: "service_manager" }));
vi.mock("server-only", () => ({}));
vi.mock("@or-on/crm", async (importOriginal) => ({
  ...(await importOriginal<typeof CrmModule>()),
  getFieldServiceFeatureState: () => Promise.resolve({ effective: true }),
  getTenantFeatureSnapshot: () =>
    Promise.resolve({
      field_service: {
        effective: true,
        configuration: { experience: state.experience },
      },
      tickets: { effective: true },
    }),
  getServiceCaseDossier: () => Promise.resolve({ case: {} }),
  listTechnicians: () => Promise.resolve([]),
  listServiceCaseLinkCandidates: () => Promise.resolve({}),
  getTenantSettings: () => Promise.resolve({ timezone: "Asia/Jerusalem" }),
}));
vi.mock("../src/features/auth", () => ({
  ForbiddenError: class extends Error {},
  UnauthenticatedError: class extends Error {},
  withCurrentTenant: (
    _permission: string,
    work: (sql: object, session: object) => Promise<unknown>,
  ) => work({}, { tenant: { role: "owner" }, isSuperuser: false }),
}));
vi.mock("../src/features/field-service", () => ({
  uuidPattern: /^[\da-f-]{36}$/iu,
  dossierForVoiceAccess: (dossier: object) => dossier,
  linkCandidatesForVoiceAccess: (candidates: object) => candidates,
  ServiceCaseWorkspace: ({ serviceManager }: { serviceManager?: boolean }) => (
    <h1>
      {serviceManager ? "Simplified case screen" : "Standard case screen"}
    </h1>
  ),
}));

import ServiceCasePage from "../src/app/field-service/cases/[id]/page";

describe("tenant experience reaches the field-service case screen", () => {
  it.each([
    ["service_manager", "Simplified case screen"],
    ["standard", "Standard case screen"],
  ])(
    "renders %s without changing the other tenant experience",
    async (experience, label) => {
      state.experience = experience;
      const page = await ServiceCasePage({
        params: Promise.resolve({ id: "10000000-0000-4000-8000-000000000001" }),
      });
      expect(renderMarkup(page)).toContain(label);
    },
  );
});
