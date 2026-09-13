import { Bot, MessagesSquare, PhoneCall } from "lucide-react";
import { useTranslations } from "next-intl";
import { BrandMark } from "./mark";

/** Static brand architecture motif, never a provider health or flow-status claim. */
export function EntryStory() {
  const t = useTranslations("premiumEntry");
  return (
    <section className="entry-story" aria-label={t("workspace")}>
      <div className="entry-story__brand">
        <BrandMark size={40} />
        <strong>Or-On Platform</strong>
        <span>{t("workspace")}</span>
      </div>
      <div className="entry-story__showcase">
        <span className="entry-story__eyebrow">{t("showcaseEyebrow")}</span>
        <h2>{t("statement")}</h2>
        <p>{t("description")}</p>
        <div className="entry-story__flow" role="list">
          <div className="entry-story__flow-node" role="listitem">
            <MessagesSquare aria-hidden="true" size={20} />
            <span>{t("messaging")}</span>
          </div>
          <div
            className="entry-story__flow-node entry-story__flow-node--core"
            role="listitem"
          >
            <BrandMark size={52} />
            <span>{t("customerContext")}</span>
          </div>
          <div className="entry-story__flow-node" role="listitem">
            <PhoneCall aria-hidden="true" size={20} />
            <span>{t("voice")}</span>
          </div>
          <div className="entry-story__flow-node" role="listitem">
            <Bot aria-hidden="true" size={20} />
            <span>{t("automation")}</span>
          </div>
        </div>
      </div>
      <div className="entry-story__footer">
        <div>
          <strong>{t("context")}</strong>
          <p>{t("conversation")}</p>
        </div>
        <div className="entry-story__principles">
          <strong>{t("continuity")}</strong>
          <p>{t("workspace")}</p>
        </div>
      </div>
    </section>
  );
}
