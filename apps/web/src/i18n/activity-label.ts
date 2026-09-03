import english from "./messages/en.json";

/** Protocol event codes remain in technical disclosures, never the primary label. */
export function activityLabel(
  eventType: string,
  t: (key: string) => string,
): string {
  const families = [
    ["message.inbound.", "inbound"],
    ["message.outbound.", "outbound"],
    ["voice.call.", "call"],
    ["crm.deal.", "deal"],
    ["automation.run.", "automation"],
    ["campaign.messaging.", "campaign"],
    ["handoff.", "handoff"],
  ] as const;
  const family = families.find(([prefix]) => eventType.startsWith(prefix));
  if (!family) return t("activity.event");
  const status = eventType.slice(family[0].length);
  return (
    t(`activity.${family[1]}`) +
    " · " +
    (Object.hasOwn(english.status, status)
      ? t(`status.${status}`)
      : t("common.unknown"))
  );
}
