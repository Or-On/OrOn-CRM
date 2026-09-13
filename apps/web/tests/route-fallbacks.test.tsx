import { createTranslator } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "../src/i18n/messages/en.json";
import { localized } from "./localized";

const { currentPublicSession, getTranslations, redirect } = vi.hoisted(() => ({
  currentPublicSession: vi.fn(),
  getTranslations: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next-intl/server", () => ({ getTranslations }));
vi.mock("../src/features/auth", () => ({ currentPublicSession }));

import ErrorBoundary from "../src/app/error";
import GlobalError from "../src/app/global-error";
import Loading from "../src/app/loading";
import NotFound from "../src/app/not-found";
import { AccessDenied } from "../src/i18n/access-denied";
import StartPage from "../src/app/start/page";

function expectOneMainLandmark(markup: string) {
  expect(markup.match(/<main\b/gu)).toHaveLength(1);
  expect(markup.match(/<\/main>/gu)).toHaveLength(1);
}

function publicSession(permissions: readonly string[]) {
  return {
    expiresAt: "2099-01-01T00:00:00.000Z",
    memberships: [],
    permissions,
    tenant: {
      role: "viewer",
      tenantId: "00000000-0000-4000-8000-000000000001",
      tenantName: "Fictional Workspace",
      tenantSlug: "fictional-workspace",
    },
    user: {
      email: "viewer@example.invalid",
      id: "00000000-0000-4000-8000-000000000002",
    },
  };
}

describe("workspace onboarding", () => {
  beforeEach(() => {
    currentPublicSession.mockReset();
    getTranslations.mockReset();
    redirect.mockReset();
    const translate = createTranslator({ locale: "en", messages: en });
    getTranslations.mockImplementation((namespace: string) =>
      Promise.resolve((key: string, values?: Record<string, string | number>) =>
        translate(
          `${namespace}.${key}` as Parameters<typeof translate>[0],
          values,
        ),
      ),
    );
  });

  it("offers a truthful read-only checklist without mutation links or copy", async () => {
    currentPublicSession.mockResolvedValue(
      publicSession(["platform:read", "voice:read", "crm:read"]),
    );

    const markup = renderToStaticMarkup(await StartPage());

    expectOneMainLandmark(markup);
    expect(markup).toContain(en.common.readOnly);
    expect(markup).toContain(en.inbox.readOnly);
    expect(markup).not.toContain("add a fictional contact or import a CSV");
    expect(markup).not.toContain("send a simulator reply");
    expect(markup).not.toContain('href="/contacts"');
    expect(markup).not.toContain('href="/inbox"');
    expect(markup).not.toContain('href="/pipelines"');
  });

  it("reveals contact, messaging, and pipeline actions only with matching capabilities", async () => {
    currentPublicSession.mockResolvedValue(
      publicSession([
        "platform:read",
        "crm:read",
        "crm:write",
        "messaging:operate",
        "pipelines:manage",
      ]),
    );

    const markup = renderToStaticMarkup(await StartPage());

    expectOneMainLandmark(markup);
    expect(markup).toContain(en.start.contactsBody);
    expect(markup).toContain(en.start.inboxBody);
    expect(markup).toContain('href="/contacts"');
    expect(markup).toContain('href="/inbox"');
    expect(markup).toContain('href="/pipelines"');
    expect(markup).not.toContain('href="/settings"');
  });
});

describe("route fallback landmarks", () => {
  it("renders exactly one main landmark for segment, not-found, and global errors", () => {
    const segmentError = renderToStaticMarkup(
      localized(<ErrorBoundary error={new Error("fixture")} retry={vi.fn()} />),
    );
    const notFound = renderToStaticMarkup(localized(<NotFound />));
    const accessDenied = renderToStaticMarkup(localized(<AccessDenied />));
    const globalError = renderToStaticMarkup(<GlobalError retry={vi.fn()} />);
    const loading = renderToStaticMarkup(localized(<Loading />));

    expectOneMainLandmark(segmentError);
    expectOneMainLandmark(notFound);
    expectOneMainLandmark(globalError);
    for (const markup of [segmentError, notFound, accessDenied, globalError]) {
      expect(markup.match(/<h1\b/gu)).toHaveLength(1);
    }
    expectOneMainLandmark(accessDenied);
    expect(accessDenied).toContain("route-state__symbol");
    expect(notFound).toContain("route-state--not-found");
    expect(notFound).toContain("/brand/logo.webp");
    expect(notFound).toContain("Or-On Platform");
    expect(notFound).toContain(en.feedback.notFoundEyebrow);
    expect(notFound).toContain(en.feedback.notFoundTitle);
    expectOneMainLandmark(loading);
    expect(loading).toContain('aria-busy="true"');
    expect(loading.match(/or-skeleton/gu)?.length).toBeGreaterThan(4);
  });

  it("keeps the root failure document self-contained with a title and critical styles", () => {
    const markup = renderToStaticMarkup(<GlobalError retry={vi.fn()} />);

    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain(
      `<title>${en.feedback.errorTitle} · Or-On Platform</title>`,
    );
    expect(markup.match(/<title>/gu)).toHaveLength(1);
    expect(markup).toContain("background:#171717");
    expect(markup).toContain("color:#fafafa");
    expect(markup).toContain("min-height:100vh");
  });
});
