import { productMetadata } from "../../i18n/product-metadata";
import { AccessDenied } from "../../i18n/access-denied";
import { redirect } from "next/navigation";

import {
  listConversationPage,
  listMessagePage,
  listQuickReplies,
  listTeamMembers,
  listAgentProfiles,
} from "@or-on/crm";
import { loadConfig } from "@or-on/config";
import { hasPermission } from "@or-on/auth";

import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
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
    const params = await searchParams;
    const requested = params.conversation;
    const initialSearch =
      typeof params.search === "string" ? params.search.slice(0, 120) : "";
    const initialFilter = [
      "mine",
      "unassigned",
      "unread",
      "open",
      "waiting",
      "closed",
    ].includes(typeof params.filter === "string" ? params.filter : "")
      ? (params.filter as
          "mine" | "unassigned" | "unread" | "open" | "waiting" | "closed")
      : "all";
    const requestedId =
      typeof requested === "string" &&
      /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(requested)
        ? requested
        : undefined;
    const data = await withCurrentTenant("crm:read", async (sql, session) => {
      const conversationPage = await listConversationPage(sql, {
        query: initialSearch,
        filter: initialFilter,
        currentUserId: session.userId,
      });
      let conversations = conversationPage.conversations;
      if (
        requestedId &&
        !conversations.some((conversation) => conversation.id === requestedId)
      )
        conversations = [
          ...(
            await listConversationPage(sql, {
              conversationId: requestedId,
              currentUserId: session.userId,
            })
          ).conversations,
          ...conversations,
        ];
      const first =
        conversations.find((conversation) => conversation.id === requestedId) ??
        conversations[0];
      const page =
        first === undefined
          ? { messages: [], nextCursor: null }
          : await listMessagePage(sql, first.id, { includeMedia: true });
      const [quickReplies, teamMembers, agentProfiles] = await Promise.all([
        listQuickReplies(sql),
        listTeamMembers(sql),
        listAgentProfiles(sql),
      ]);
      return {
        conversations,
        conversationNextCursor: conversationPage.nextCursor,
        ...page,
        selectedId: first?.id,
        quickReplies,
        teamMembers,
        // An operator may hand a conversation only to the agent version the
        // platform would actually run: the live one. The newest version is
        // routinely an unpublished draft, and offering that would bind the
        // conversation to something the ownership gate refuses.
        agentProfiles: agentProfiles.filter(
          (profile) =>
            profile.publishedVersionId !== null &&
            profile.publishedChannels.includes("whatsapp"),
        ),
        canOperate:
          session.isSuperuser ||
          hasPermission(session.tenant.role, "messaging:operate"),
        currentUserId: session.userId,
      };
    });
    return (
      <main className="page page--inbox">
        <InboxWorkspace
          conversations={data.conversations}
          initialConversationNextCursor={data.conversationNextCursor}
          initialMessages={data.messages}
          initialConversationId={data.selectedId}
          initialNextCursor={data.nextCursor}
          canOperate={data.canOperate}
          currentUserId={data.currentUserId}
          initialSearch={initialSearch}
          initialFilter={initialFilter}
          metaSenderId={platformConfig.whatsApp.phoneNumberId}
          quickReplies={data.quickReplies}
          realWhatsAppEnabled={platformConfig.enableRealWhatsApp}
          teamMembers={data.teamMembers}
          agentProfiles={data.agentProfiles}
          aiRepliesEnabled={platformConfig.enableWhatsAppAi}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("inbox");
