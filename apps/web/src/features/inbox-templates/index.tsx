"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button, Dialog } from "@or-on/ui";
import type { InboxTemplate } from "./catalog";

export function InboxTemplatePicker({
  conversationId,
  open,
  onClose,
  onSelect,
}: {
  readonly conversationId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelect: (template: InboxTemplate) => void;
}) {
  const he = useLocale().startsWith("he");
  const [templates, setTemplates] = useState<readonly InboxTemplate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [after, setAfter] = useState<string>();
  useEffect(() => {
    if (!open) {
      setAfter(undefined);
      setTemplates([]);
      return;
    }
    if (!after) setTemplates([]);
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void fetch(
      `/api/messaging/conversations/${encodeURIComponent(conversationId)}/templates${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("catalog unavailable");
        const page = (await response.json()) as {
          templates: readonly InboxTemplate[];
          nextCursor: string | null;
        };
        if (!Array.isArray(page.templates)) throw new Error("invalid catalog");
        if (controller.signal.aborted) return;
        setTemplates((current) =>
          after ? [...current, ...page.templates] : page.templates,
        );
        setCursor(page.nextCursor);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, conversationId, after, revision]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={he ? "תבניות WhatsApp" : "WhatsApp templates"}
      closeLabel={he ? "סגירה" : "Close"}
      className="inbox-template-dialog"
    >
      <p>
        {he
          ? "הקטלוג שייך לחשבון של השיחה. בחירה ממלאת טיוטה; השליחה מתבצעת בנפרד."
          : "This catalog belongs to the conversation’s account. Choose a template to fill a draft; sending is a separate action."}
      </p>
      {loading ? (
        <p role="status">{he ? "טוען תבניות…" : "Loading templates…"}</p>
      ) : null}
      {failed ? (
        <div role="alert">
          <p>
            {he
              ? "לא ניתן לאמת כרגע את קטלוג החשבון. בדקו שהערוץ מופעל והחשבון מוגדר."
              : "The account catalog could not be verified. Check that the channel is enabled and its account is configured."}
          </p>
          <Button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            {he ? "ניסיון נוסף" : "Retry"}
          </Button>
        </div>
      ) : null}
      {!failed && !loading && templates.length === 0 ? (
        <p>{he ? "אין תבניות בחשבון זה." : "This account has no templates."}</p>
      ) : null}
      <div className="inbox-template-list">
        {templates.map((template) => (
          <article key={`${template.name}:${template.language}`}>
            <header>
              <strong dir="auto">{template.name}</strong>
              <span>
                <bdi>{template.language}</bdi> · {template.status}
              </span>
            </header>
            <p dir="auto">{template.body}</p>
            {!template.supported ? (
              <small>
                {he
                  ? "תבנית זו דורשת מדיה או רכיבים שהעורך אינו תומך בהם."
                  : "This template requires media or components that this composer does not support."}
              </small>
            ) : null}
            <Button
              type="button"
              disabled={template.status !== "APPROVED" || !template.supported}
              onClick={() => {
                onSelect(template);
                onClose();
              }}
            >
              {he ? "מילוי טיוטה" : "Use in draft"}
            </Button>
          </article>
        ))}
      </div>
      {cursor && !failed ? (
        <Button
          type="button"
          disabled={loading}
          onClick={() => setAfter(cursor)}
        >
          {he ? "טעינת עוד" : "Load more"}
        </Button>
      ) : null}
    </Dialog>
  );
}
