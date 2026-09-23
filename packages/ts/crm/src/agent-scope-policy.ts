/**
 * Executable service-agent scope policy shared with the voice runtime.
 *
 * The canonical data is `db/contracts/service-agent-policy.v1.json`, mirrored
 * into `agent-scope-policy.generated.ts`. The model may propose wording; this
 * module decides whether a customer turn is answered by an approved server
 * response and whether generated wording may reach the customer at all. It is
 * a platform protection: tenant configuration supplies only the trusted
 * business display name used inside approved wording.
 */
import { serviceAgentPolicy } from "./agent-scope-policy.generated.js";

export const agentScopePolicyVersion = serviceAgentPolicy.policyVersion;

export type ApprovedResponseKind =
  "identity" | "scope" | "data" | "recipient" | "fallback";

const strip = /[֑-ׇ­​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
const joiners = new RegExp(
  `[${serviceAgentPolicy.normalization.joiners.replace(/[\\\]^-]/gu, "\\$&")}]`,
  "gu",
);
const outside = new RegExp(
  `[^${serviceAgentPolicy.normalization.keep}]+`,
  "gu",
);

/** The policy's single normalization; the Python runtime mirrors it exactly. */
export function normalizeScopeText(text: string): string {
  const value = text
    .normalize("NFKC")
    .replace(strip, "")
    .toLowerCase()
    .replace(joiners, "")
    .replace(outside, " ");
  const words = value.split(" ").filter((word) => word.length > 0);
  return ` ${words.join(" ")} `;
}

function compile(patterns: readonly string[]): readonly RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern, "u"));
}

function compileMap(
  source: Readonly<Record<string, readonly string[]>>,
): ReadonlyMap<string, readonly RegExp[]> {
  return new Map(
    Object.entries(source).map(([key, patterns]) => [key, compile(patterns)]),
  );
}

const turnPatterns = compileMap(serviceAgentPolicy.turnCategories);
const servicePatterns = compile(serviceAgentPolicy.serviceSignals);
const outputPatterns = compileMap(serviceAgentPolicy.outputCategories);
const rawOutputPatterns = compileMap(serviceAgentPolicy.rawOutputPatterns);
const routed: ReadonlySet<string> = new Set(
  serviceAgentPolicy.routing.routedCategories,
);
const responseFor: Readonly<Record<string, string>> =
  serviceAgentPolicy.routing.responseForCategory;
const routePriority: readonly string[] =
  serviceAgentPolicy.routing.routePriority;

export interface TurnDecision {
  readonly categories: readonly string[];
  readonly serviceSignal: boolean;
  /** An approved response the server delivers itself; null lets the model answer. */
  readonly route: Exclude<ApprovedResponseKind, "fallback"> | null;
  /** Restricted categories in a turn that also carries a service request. */
  readonly mixed: readonly string[];
}

export interface OutputVerdict {
  readonly allowed: boolean;
  readonly category: string | null;
}

export function classifyCustomerTurn(text: string): TurnDecision {
  if (typeof text !== "string" || text.trim() === "")
    return { categories: [], serviceSignal: false, route: null, mixed: [] };
  const normalized = normalizeScopeText(text.slice(0, 8192));
  const categories = [...turnPatterns.entries()]
    .filter(([, patterns]) =>
      patterns.some((pattern) => pattern.test(normalized)),
    )
    .map(([category]) => category)
    .sort();
  const serviceSignal = servicePatterns.some((pattern) =>
    pattern.test(normalized),
  );
  const restricted = categories.filter((category) => routed.has(category));
  if (restricted.length === 0)
    return { categories, serviceSignal, route: null, mixed: [] };
  if (serviceSignal)
    return { categories, serviceSignal, route: null, mixed: restricted };
  const responses = new Set(
    restricted.map((category) => responseFor[category]),
  );
  const route = routePriority.find((response) => responses.has(response)) as
    TurnDecision["route"] | undefined;
  return { categories, serviceSignal, route: route ?? "identity", mixed: [] };
}

/**
 * Reject customer-visible wording that leaves the service scope. Exact
 * server-approved responses are always allowed.
 */
export function validateAgentOutput(
  text: string,
  approved: ReadonlySet<string> = new Set(),
): OutputVerdict {
  if (typeof text !== "string") return { allowed: false, category: "invalid" };
  const stripped = text.trim();
  if (stripped === "" || approved.has(stripped))
    return { allowed: true, category: null };
  for (const [category, patterns] of rawOutputPatterns)
    if (patterns.some((pattern) => pattern.test(stripped)))
      return { allowed: false, category };
  const normalized = normalizeScopeText(stripped.slice(0, 8192));
  for (const [category, patterns] of outputPatterns)
    if (patterns.some((pattern) => pattern.test(normalized)))
      return { allowed: false, category };
  return { allowed: true, category: null };
}

function languageKey(locale: string): "he" | "en" {
  return locale.toLowerCase().startsWith("he") ? "he" : "en";
}

export function approvedAgentResponse(
  kind: ApprovedResponseKind,
  locale: string,
  businessName: string | null | undefined,
): string {
  const key = languageKey(locale);
  const name =
    (businessName ?? "").trim().slice(0, 120) ||
    serviceAgentPolicy.approvedResponses.businessFallbackName[key];
  return serviceAgentPolicy.approvedResponses[kind][key].replaceAll(
    "{business}",
    name,
  );
}

export function approvedAgentResponses(
  businessName: string | null | undefined,
): ReadonlySet<string> {
  const kinds: readonly ApprovedResponseKind[] = [
    "identity",
    "scope",
    "data",
    "recipient",
    "fallback",
  ];
  return new Set(
    kinds.flatMap((kind) =>
      ["he", "en"].map((locale) =>
        approvedAgentResponse(kind, locale, businessName),
      ),
    ),
  );
}

export function agentScopeNotice(categories: readonly string[]): string {
  return serviceAgentPolicy.scopeNotice.replace(
    "{categories}",
    categories.join(", "),
  );
}
