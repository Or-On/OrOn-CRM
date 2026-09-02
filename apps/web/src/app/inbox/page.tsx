import { redirect } from "next/navigation";

import {
  listConversations,
  listMessagePage,
  listQuickReplies,
  listTeamMembers,
} from "@or-on/crm";
import { loadConfig } from "@or-on/config";
import { hasPermission } from "@or-on/auth";

import { UnauthenticatedError, withCurrentTenant } from "../../features/auth";
import { InboxWorkspace } from "../../features/inbox";

export default async function InboxPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    const platformConfig = loadConfig(process.env, {
      requireWhatsApp: true,
      service: "web",
    });
    const requested = (await searchParams).conversation;
    const requestedId =
      typeof requested === "string" &&
      /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(requested)
        ? requested
        : undefined;
    const data = await withCurrentTenant("crm:read", async (sql, session) => {
      let conversations = await listConversations(sql);
      if (
        requestedId &&
        !conversations.some((conversation) => conversation.id === requestedId)
      )
        conversations = [
          ...(await listConversations(sql, requestedId)),
          ...conversations,
        ];
      const first =
        conversations.find((conversation) => conversation.id === requestedId) ??
        conversations[0];
      const page =
        first === undefined
          ? { messages: [], nextCursor: null }
          : await listMessagePage(sql, first.id);
      const quickReplies = await listQuickReplies(sql);
      const teamMembers = await listTeamMembers(sql);
      return {
        conversations,
        ...page,
        selectedId: first?.id,
        quickReplies,
        teamMembers,
        canOperate: hasPermission(session.tenant.role, "messaging:operate"),
      };
    });
    return (
      <main className="page page--inbox">
        <header className="page-heading">
          <p className="eyebrow">Customer conversations</p>
          <h1>Inbox</h1>
          <p>Every conversation, with the context to move it forward.</p>
        </header>
        <InboxWorkspace
          conversations={data.conversations}
          initialMessages={data.messages}
          initialConversationId={data.selectedId}
          initialNextCursor={data.nextCursor}
          canOperate={data.canOperate}
          metaSenderId={platformConfig.whatsApp.phoneNumberId}
          quickReplies={data.quickReplies}
          realWhatsAppEnabled={platformConfig.enableRealWhatsApp}
          teamMembers={data.teamMembers}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
