"use client";

import { Textarea } from "@or-on/ui";
import Link from "next/link";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = Record<string, Json>;
export interface SourceTextField {
  readonly path: readonly (string | number)[];
  readonly label: string;
  readonly value: string;
}
export interface SourceCard {
  readonly id: string;
  readonly fields: readonly SourceTextField[];
  readonly derived: boolean;
}
function object(value: Json | undefined): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Paths point into persisted Composition source, never into the compiled spec. */
export function sourceCards(source: ObjectValue): readonly SourceCard[] {
  const cards: SourceCard[] = [];
  if (Array.isArray(source.steps))
    source.steps.forEach((step, index) => {
      if (!object(step)) return;
      const fields: SourceTextField[] = [];
      for (const [key, label] of [
        ["say", "פתיחה / טקסט מוקרא"],
        ["task", "משימת השלב"],
      ] as const) {
        if (
          typeof step[key] === "string" ||
          (key === "say" && step[key] === null)
        )
          fields.push({
            path: ["steps", index, key],
            label,
            value: step[key] ?? "",
          });
      }
      cards.push({
        id: typeof step.id === "string" ? step.id : String(index),
        fields,
        derived: fields.length === 0,
      });
    });
  if (Array.isArray(source.nodes))
    source.nodes.forEach((node, index) => {
      if (!object(node)) return;
      const fields: SourceTextField[] = [];
      if (typeof node.role_message === "string")
        fields.push({
          path: ["nodes", index, "role_message"],
          label: "הוראות תפקיד של השלב",
          value: node.role_message,
        });
      if (Array.isArray(node.task_messages))
        node.task_messages.forEach((message, messageIndex) => {
          if (object(message) && typeof message.content === "string")
            fields.push({
              path: ["nodes", index, "task_messages", messageIndex, "content"],
              label: `משימת השלב ${String(messageIndex + 1)}`,
              value: message.content,
            });
        });
      if (Array.isArray(node.pre_actions))
        node.pre_actions.forEach((action, actionIndex) => {
          if (
            object(action) &&
            action.type === "tts_say" &&
            typeof action.text === "string"
          )
            fields.push({
              path: ["nodes", index, "pre_actions", actionIndex, "text"],
              label: "פתיחה מוקראת",
              value: action.text,
            });
        });
      cards.push({
        id: typeof node.name === "string" ? node.name : String(index),
        fields,
        derived: fields.length === 0,
      });
    });
  return cards;
}

export function editSourceText(
  source: ObjectValue,
  path: readonly (string | number)[],
  text: string,
): ObjectValue {
  const cloned = structuredClone(source);
  let parent: Json = cloned;
  for (const key of path.slice(0, -1)) {
    const next: Json | undefined =
      Array.isArray(parent) && typeof key === "number"
        ? parent[key]
        : object(parent)
          ? parent[String(key)]
          : undefined;
    if (next === undefined) throw new Error("Source path no longer exists");
    parent = next;
  }
  const key = path.at(-1);
  if (
    !object(parent) ||
    typeof key !== "string" ||
    (typeof parent[key] !== "string" &&
      !(key === "say" && parent[key] === null))
  )
    throw new Error("Only existing source text can be edited");
  parent[key] = text;
  return cloned;
}

export function StructuredVoiceSource({
  source,
  disabled,
  onChange,
}: {
  readonly source: string;
  readonly disabled: boolean;
  readonly onChange: (source: string) => void;
}) {
  let parsed: ObjectValue;
  try {
    const value = JSON.parse(source) as Json;
    if (!object(value)) throw new Error("object required");
    parsed = value;
  } catch {
    return (
      <p role="alert" dir="rtl">
        יש לתקן את ה־JSON לפני עריכה בכרטיסים. השינויים נשמרים בעורך המתקדם.
      </p>
    );
  }
  const cards = sourceCards(parsed);
  return (
    <div dir="rtl">
      <p>
        הסוכן המשותף קובע את התפקיד העסקי. ערכו אותו במסך הסוכנים. כאן עורכים רק
        טקסט קיים במקור התהליך.
      </p>
      <Link href="/orchestration?tab=agents" className="text-link">
        בחירת הסוכן המשותף לעריכה
      </Link>
      <p>מדיניות הקול: Harper · Soniox tts-rt-v2 · נקבה</p>
      {cards.map((card, index) => (
        <section
          key={`${card.id}-${String(index)}`}
          className="canonical-flow-editor__item"
        >
          <h4>
            <bdi>{card.id}</bdi>
          </h4>
          {card.fields.map((field) => (
            <Textarea
              key={field.path.join(".")}
              id={`source-${field.path.join("-")}`}
              label={field.label}
              dir="auto"
              value={field.value}
              disabled={disabled}
              rows={3}
              onChange={(event) =>
                onChange(
                  JSON.stringify(
                    editSourceText(parsed, field.path, event.target.value),
                    null,
                    2,
                  ),
                )
              }
            />
          ))}
          {card.derived ? (
            <p>טקסט נגזר מרכיב. לקריאה בלבד; המבנה נשמר במלואו במקור המתקדם.</p>
          ) : null}
        </section>
      ))}
      {cards.length === 0 ? (
        <p>אין שדות טקסט נתמכים. אפשר לבדוק את המקור המלא בתצוגה המתקדמת.</p>
      ) : null}
    </div>
  );
}
