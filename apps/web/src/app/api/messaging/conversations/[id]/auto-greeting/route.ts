import { NextResponse } from "next/server";

import {
  getWhatsAppAutoGreeting,
  parseWhatsAppAutoGreetingInput,
  saveWhatsAppAutoGreeting,
  whatsAppConversationChannel,
} from "@or-on/crm";
import { hasPermission } from "@or-on/auth";

import {
  jsonObject,
  withCurrentTenant,
  withFreshCurrentTenant,
} from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import {
  listAllConversationTemplates,
  templateAccount,
} from "../../../../../../features/inbox-templates-server";

const noStore = { "Cache-Control": "private, no-store" };

export async function GET(
  _request: Request,
  context: RouteContext<"/api/messaging/conversations/[id]/auto-greeting">,
) {
  try {
    const { id } = await context.params;
    const result = await withCurrentTenant(
      "messaging:operate",
      async (sql, session) => ({
        greeting: await getWhatsAppAutoGreeting(
          sql,
          await whatsAppConversationChannel(sql, id),
        ),
        canManage:
          session.isSuperuser ||
          hasPermission(session.tenant.role, "tenant:manage"),
      }),
    );
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

/**
 * Saves the conversation channel's greeting. The approved languages come from
 * the provider catalog, never from the browser: only approved variants
 * without variables can be sent automatically. Turning the greeting off keeps
 * the chosen template and needs no catalog read.
 */
export async function PUT(
  request: Request,
  context: RouteContext<"/api/messaging/conversations/[id]/auto-greeting">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body = await jsonObject(request);
    if (typeof body.enabled !== "boolean")
      throw new TypeError("Choose whether the automatic greeting is on");
    if (!body.enabled) {
      const disabled = await withFreshCurrentTenant(
        "tenant:manage",
        async (sql, session) => {
          const channelId = await whatsAppConversationChannel(sql, id);
          const current = await getWhatsAppAutoGreeting(sql, channelId);
          return current === null
            ? null
            : saveWhatsAppAutoGreeting(sql, session.userId, channelId, {
                ...current,
                enabled: false,
              });
        },
      );
      return NextResponse.json(
        { greeting: disabled, canManage: true },
        { headers: noStore },
      );
    }
    const templateName =
      typeof body.templateName === "string" ? body.templateName : "";
    let principal: string | undefined;
    let binding: string | undefined;
    const templates = await listAllConversationTemplates(() =>
      withFreshCurrentTenant("tenant:manage", async (sql, session) => {
        const current = JSON.stringify([
          session.sessionId,
          session.userId,
          session.tenant.tenantId,
        ]);
        if (principal !== undefined && principal !== current)
          throw new Error("Template catalog principal changed");
        principal = current;
        const account = await templateAccount(sql, id);
        const currentBinding = JSON.stringify(account);
        if (binding !== undefined && binding !== currentBinding)
          throw new Error("Template catalog binding changed");
        binding = currentBinding;
        return account;
      }),
    );
    const languages = templates
      .filter(
        (template) =>
          template.name === templateName &&
          template.status === "APPROVED" &&
          template.draft?.parameterCount === 0,
      )
      .map((template) => template.language);
    if (languages.length === 0)
      throw new TypeError(
        "Choose a template that Meta approved and that has no variables to fill",
      );
    const input = parseWhatsAppAutoGreetingInput({
      enabled: true,
      templateName,
      languages,
      fallbackLanguage:
        typeof body.fallbackLanguage === "string" &&
        languages.includes(body.fallbackLanguage)
          ? body.fallbackLanguage
          : languages[0],
    });
    const saved = await withFreshCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        const current = JSON.stringify([
          session.sessionId,
          session.userId,
          session.tenant.tenantId,
        ]);
        if (principal === undefined || principal !== current)
          throw new Error("Template catalog principal changed");
        // Catalog I/O released its transaction. Recheck the principal and
        // exact account in the transaction that commits this configuration.
        if (binding !== JSON.stringify(await templateAccount(sql, id)))
          throw new Error("Template catalog binding changed");
        return saveWhatsAppAutoGreeting(
          sql,
          session.userId,
          await whatsAppConversationChannel(sql, id),
          input,
        );
      },
    );
    return NextResponse.json(
      { greeting: saved, canManage: true },
      { headers: noStore },
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
