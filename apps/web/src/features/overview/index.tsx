import { useTranslations, useLocale } from "next-intl";
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
  const t = useTranslations();
  const locale = useLocale();
  const indicators = [
    {
      label: t("overview.contacts"),
      value: metrics.contacts,
      icon: ContactRound,
      href: "/contacts",
      hint: t("overview.contactsHint"),
      tone: "customer",
    },
    {
      label: t("overview.conversations"),
      value: metrics.openConversations,
      icon: MessagesSquare,
      href: "/inbox",
      hint: t("overview.conversationsHint"),
      tone: "conversation",
    },
    {
      label: t("overview.handoffs"),
      value: metrics.pendingHandoffs,
      icon: Headset,
      href: "/orchestration",
      hint: t("overview.handoffsHint"),
      tone: "handoff",
    },
  ];
  return (
    <main className="page overview-page">
      <header className="overview-heading">
        <div>
          <p className="eyebrow">
            <bdi>{tenantName}</bdi>
          </p>
          <h1>{t("overview.title")}</h1>
          <p>{t("overview.description")}</p>
          <p className="overview-freshness">{t("overview.freshness")}</p>
        </div>
        <Link
          className="or-button or-button--primary action-link"
          href="/inbox"
        >
          {t("overview.openInbox")}
          <ArrowRight aria-hidden="true" size={16} />
        </Link>
      </header>
      <section aria-label={t("overview.totals")} className="overview-metrics">
        {indicators.map(({ label, value, icon: Icon, href, hint, tone }) => (
          <Link
            className="overview-metric"
            data-tone={tone}
            href={href}
            key={label}
          >
            <div>
              <span>{label}</span>
              <span className="overview-metric__icon" aria-hidden="true">
                <Icon size={18} />
              </span>
            </div>
            <strong>{value.toLocaleString(locale)}</strong>
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
              <p className="eyebrow">{t("overview.recentEyebrow")}</p>
              <h2>{t("overview.recent")}</h2>
            </div>
            <Link href="/inbox">
              {t("overview.viewInbox")}
              <ArrowRight aria-hidden="true" size={14} />
            </Link>
          </header>
          {conversations.length === 0 ? (
            <EmptyState
              title={t("overview.emptyTitle")}
              description={t("overview.emptyDescription")}
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
                      <strong>
                        <bdi>{conversation.contactName}</bdi>
                      </strong>
                      <p dir="auto">
                        {conversation.lastMessagePreview ?? t("common.noText")}
                      </p>
                      <small>
                        {conversation.provider === "meta"
                          ? "Meta WhatsApp"
                          : conversation.provider === "simulator"
                            ? t("common.simulator")
                            : conversation.channelKind}
                      </small>
                    </div>
                    <Badge
                      label={t(`status.${conversation.status}`)}
                      tone={conversation.status === "open" ? "info" : "neutral"}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Surface>
        <Surface className="overview-next">
          <p className="eyebrow">{t("overview.nextEyebrow")}</p>
          <h2>{t("overview.nextTitle")}</h2>
          <p>{t("overview.nextDescription")}</p>
          <Link href="/contacts">
            <ContactRound aria-hidden="true" size={19} />
            <span>
              <strong>{t("overview.customer")}</strong>
              <small>{t("overview.customerHint")}</small>
            </span>
            <ArrowRight aria-hidden="true" size={16} />
          </Link>
          <Link href="/voice">
            <PhoneCall aria-hidden="true" size={19} />
            <span>
              <strong>{t("overview.voice")}</strong>
              <small>{t("overview.voiceHint")}</small>
            </span>
            <ArrowRight aria-hidden="true" size={16} />
          </Link>
          <Link href="/orchestration">
            <Workflow aria-hidden="true" size={19} />
            <span>
              <strong>{t("overview.flow")}</strong>
              <small>{t("overview.flowHint")}</small>
            </span>
            <ArrowRight aria-hidden="true" size={16} />
          </Link>
        </Surface>
      </div>
      <section className="overview-mode" aria-label={t("overview.safety")}>
        <Badge
          label={realWhatsAppEnabled ? t("overview.real") : t("overview.safe")}
          tone={realWhatsAppEnabled ? "warning" : "info"}
        />
        <p>
          {realWhatsAppEnabled
            ? t("overview.realHint")
            : t("overview.safeHint")}
        </p>
        <Link href="/system/health">
          {t("overview.diagnostics")}
          <ArrowRight aria-hidden="true" size={14} />
        </Link>
      </section>
    </main>
  );
}
