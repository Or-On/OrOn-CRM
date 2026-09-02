import {
  ArrowRight,
  ContactRound,
  Headset,
  MessagesSquare,
  PhoneCall,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { Badge, EmptyState, Surface } from "@or-on/ui";
import type { ConversationSummary, OverviewMetrics } from "@or-on/crm";

export function Overview({
  tenantName,
  metrics,
  conversations,
  realWhatsAppEnabled,
}: {
  readonly tenantName: string;
  readonly metrics: OverviewMetrics;
  readonly conversations: readonly ConversationSummary[];
  readonly realWhatsAppEnabled: boolean;
}) {
  const indicators = [
    {
      label: "Active contacts",
      value: metrics.contacts,
      icon: ContactRound,
      href: "/contacts",
      hint: "Your customer relationships",
    },
    {
      label: "Open conversations",
      value: metrics.openConversations,
      icon: MessagesSquare,
      href: "/inbox",
      hint: "Open and pending, across channels",
    },
    {
      label: "Pending handoffs",
      value: metrics.pendingHandoffs,
      icon: Headset,
      href: "/orchestration",
      hint: "Waiting for an operator",
    },
  ];
  return (
    <main className="page overview-page">
      <header className="overview-heading">
        <div>
          <p className="eyebrow">{tenantName}</p>
          <h1>Your workspace, at a glance.</h1>
          <p>Stay close to every conversation. Keep the next step in sight.</p>
        </div>
        <Link
          className="or-button or-button--primary action-link"
          href="/inbox"
        >
          Open Inbox <ArrowRight aria-hidden="true" size={16} />
        </Link>
      </header>
      <section aria-label="Workspace totals" className="overview-metrics">
        {indicators.map(({ label, value, icon: Icon, href, hint }) => (
          <Link className="overview-metric" href={href} key={label}>
            <div>
              <span>{label}</span>
              <Icon aria-hidden="true" size={19} />
            </div>
            <strong>{value.toLocaleString("en")}</strong>
            <small>
              {hint}
              <ArrowRight aria-hidden="true" size={14} />
            </small>
          </Link>
        ))}
      </section>
      <div className="overview-columns">
        <Surface className="overview-conversations">
          <header className="section-heading">
            <div>
              <p className="eyebrow">Stay in the loop</p>
              <h2>Recent conversations</h2>
            </div>
            <Link href="/inbox">
              View Inbox <ArrowRight aria-hidden="true" size={14} />
            </Link>
          </header>
          {conversations.length === 0 ? (
            <EmptyState
              title="A clear start"
              description="New conversations will appear here. Open the Inbox to explore the fictional simulator."
            />
          ) : (
            <ul className="overview-activity">
              {conversations.slice(0, 5).map((conversation) => (
                <li key={conversation.id}>
                  <Link
                    href={`/inbox?conversation=${encodeURIComponent(conversation.id)}`}
                  >
                    <span className="contact-avatar" aria-hidden="true">
                      {conversation.contactName.slice(0, 1)}
                    </span>
                    <div>
                      <strong>{conversation.contactName}</strong>
                      <p>
                        {conversation.lastMessagePreview ??
                          "No text preview available"}
                      </p>
                      <small>
                        {conversation.provider === "meta"
                          ? "Meta WhatsApp"
                          : conversation.provider === "simulator"
                            ? "Simulator"
                            : conversation.channelKind}
                      </small>
                    </div>
                    <Badge
                      label={conversation.status}
                      tone={conversation.status === "open" ? "info" : "neutral"}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Surface>
        <Surface className="overview-next">
          <p className="eyebrow">One connected workspace</p>
          <h2>Keep the conversation moving.</h2>
          <p>
            Customer context, a recorded call result, and a thoughtful
            follow-up—all in one place.
          </p>
          <Link href="/contacts">
            <ContactRound aria-hidden="true" size={19} />
            <span>
              <strong>Know your customer</strong>
              <small>Identities, consent and activity</small>
            </span>
            <ArrowRight aria-hidden="true" size={16} />
          </Link>
          <Link href="/voice">
            <PhoneCall aria-hidden="true" size={19} />
            <span>
              <strong>Review voice activity</strong>
              <small>Call records and simulator results</small>
            </span>
            <ArrowRight aria-hidden="true" size={16} />
          </Link>
          <Link href="/orchestration">
            <Workflow aria-hidden="true" size={19} />
            <span>
              <strong>Connect the next step</strong>
              <small>Versioned flows and human handoff</small>
            </span>
            <ArrowRight aria-hidden="true" size={16} />
          </Link>
        </Surface>
      </div>
      <section className="overview-mode" aria-label="Delivery safety">
        <Badge
          label={
            realWhatsAppEnabled
              ? "Real WhatsApp enabled"
              : "Simulator-first workspace"
          }
          tone={realWhatsAppEnabled ? "warning" : "info"}
        />
        <p>
          {realWhatsAppEnabled
            ? "Real delivery still requires an explicit choice and confirmation. Enabled configuration is not a provider health check."
            : "Simulations never contact a real recipient. Voice results are labelled simulations; real delivery is not implied."}
        </p>
        <Link href="/system/health">
          System diagnostics <ArrowRight aria-hidden="true" size={14} />
        </Link>
      </section>
    </main>
  );
}
