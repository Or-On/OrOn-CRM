import { redirect } from "next/navigation";

import { listConversations, listMessages } from "@or-on/crm";

import { UnauthenticatedError, withCurrentTenant } from "../../features/auth";
import { InboxWorkspace } from "../../features/inbox";

export default async function InboxPage() {
  try {
    const data = await withCurrentTenant("crm:read", async (sql) => {
      const conversations = await listConversations(sql);
      const first = conversations[0];
      const messages =
        first === undefined ? [] : await listMessages(sql, first.id);
      return { conversations, messages };
    });
    return (
      <main className="page page--inbox">
        <header className="page-heading">
          <p className="eyebrow">Omnichannel operations</p>
          <h1>Inbox</h1>
          <p>
            Tenant-safe conversations with durable simulated WhatsApp delivery.
          </p>
        </header>
        <InboxWorkspace
          conversations={data.conversations}
          initialMessages={data.messages}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
