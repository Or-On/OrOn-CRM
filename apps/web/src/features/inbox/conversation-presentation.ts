export function conversationDayKey(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function previousConversationDay(dayKey: string): string {
  const day = new Date(`${dayKey}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

export function conversationChannelKey(kind: string): string {
  switch (kind) {
    case "whatsapp":
      return "inbox.whatsapp";
    case "email":
      return "shell.email";
    case "sms":
      return "inbox.sms";
    case "webchat":
      return "inbox.webchat";
    default:
      return "common.unknown";
  }
}
