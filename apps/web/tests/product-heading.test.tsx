import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { ProductHeading } from "../src/i18n/product-heading";

const messages = {
  pages: {
    inboxDescription: "Tenant-safe conversations",
    inboxEyebrow: "Workspace",
    inboxTitle: "Inbox",
  },
};

describe("localized product heading", () => {
  it("adapts localized route copy to the shared page header", () => {
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ProductHeading page="inbox" />
      </NextIntlClientProvider>,
    );

    expect(markup).toContain('class="or-page-header page-heading"');
    expect(markup).toContain("<h1>Inbox</h1>");
    expect(markup).toContain("Tenant-safe conversations");
  });

  it("keeps the premium workspace treatment opt-in", () => {
    const premiumMarkup = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ProductHeading page="inbox" premium />
      </NextIntlClientProvider>,
    );
    const defaultMarkup = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ProductHeading page="inbox" />
      </NextIntlClientProvider>,
    );

    expect(premiumMarkup).toContain("page-heading--premium");
    expect(defaultMarkup).not.toContain("page-heading--premium");
  });

  it("keeps Inbox outside the premium workspace scope", () => {
    const inboxPage = readFileSync(
      new URL("../src/app/inbox/page.tsx", import.meta.url),
      "utf8",
    );

    expect(inboxPage).toContain('className="page page--inbox"');
    expect(inboxPage).not.toContain("page--workspace-premium");
  });
});
