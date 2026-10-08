import { NextResponse } from "next/server";
import { loadConfig } from "@or-on/config";
import {
  EffectivePromptContextRequired,
  loadEffectivePromptContext,
} from "@or-on/crm";
import {
  issueControlApiGrant,
  withFreshCurrentTenant,
} from "../../../../../../../../features/auth";
import { crmErrorResponse } from "../../../../../../../../features/crm-route";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const privateResponse = (response: Response) => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  try {
    const { id, versionId } = await context.params;
    const params = new URL(request.url).searchParams;
    const channel = params.get("channel");
    const processId = params.get("processId");
    const nodeId = params.get("nodeId");
    if (
      !uuid.test(id) ||
      !uuid.test(versionId) ||
      (channel !== "voice" && channel !== "whatsapp") ||
      (processId !== null && !uuid.test(processId)) ||
      (nodeId !== null && (nodeId.length > 160 || !nodeId.trim())) ||
      [...params.keys()].some(
        (k) => !["channel", "processId", "nodeId"].includes(k),
      )
    )
      return privateResponse(
        NextResponse.json(
          { error: "invalid_effective_prompt_context" },
          { status: 400 },
        ),
      );
    const loaded = await withFreshCurrentTenant(
      "crm:read",
      async (sql, session) => ({
        result: await loadEffectivePromptContext(sql, {
          profileId: id,
          versionId,
          channel,
          ...(processId === null ? {} : { processId }),
          ...(nodeId === null ? {} : { nodeId }),
        }),
        assertion:
          channel === "voice"
            ? await issueControlApiGrant(session, "orchestration:read")
            : null,
      }),
    );
    if (!loaded.result)
      return privateResponse(
        NextResponse.json({ error: "not_found" }, { status: 404 }),
      );
    const { preview, context: selection, contextOptions } = loaded.result;
    let instruction: unknown = {
      ...preview,
      scriptedOpening: null,
      exclusions: [
        "תצוגת עריכה עם הקשר שיחה ריק; זו אינה הקלטה של בקשת מודל מלקוח.",
        "היסטוריית שיחה, פרטי לקוח, תוכן ידע, תוצאות כלים ונתוני העסק אינם מוצגים כאן.",
        "שפה, שדות חסרים, יכולת שליחת טופס וכללי מעטפת עשויים להשתנות בהתאם למצב השיחה.",
      ],
    };
    if (channel === "voice") {
      if (!loaded.assertion)
        throw new Error("missing authorized read assertion");
      const config = loadConfig(process.env, { service: "web" });
      const target = new URL(
        `/api/v1/orchestration/agents/${id}/versions/${versionId}/effective-prompt`,
        config.controlApiUrl,
      );
      if (
        selection.retainedFlowId !== null &&
        selection.retainedFlowVersion !== null
      ) {
        target.searchParams.set("flow_id", selection.retainedFlowId);
        target.searchParams.set(
          "flow_version",
          String(selection.retainedFlowVersion),
        );
      }
      if (nodeId !== null) target.searchParams.set("node_id", nodeId);
      const response = await fetch(target, {
        headers: { authorization: `Bearer ${loaded.assertion}` },
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok)
        return privateResponse(
          NextResponse.json(
            { error: "voice_effective_prompt_unavailable" },
            {
              status: [400, 401, 403, 404, 409].includes(response.status)
                ? response.status
                : 503,
            },
          ),
        );
      instruction = await response.json();
      if (
        instruction === null ||
        typeof instruction !== "object" ||
        !("text" in instruction) ||
        !("hash" in instruction)
      )
        throw new Error("invalid control API instruction result");
    }
    return privateResponse(
      NextResponse.json({
        ...(instruction as object),
        context: selection,
        contextOptions,
      }),
    );
  } catch (error) {
    if (error instanceof EffectivePromptContextRequired)
      return privateResponse(
        NextResponse.json(
          { error: error.message, contextOptions: error.contextOptions },
          { status: 409 },
        ),
      );
    return privateResponse(crmErrorResponse(error));
  }
}
