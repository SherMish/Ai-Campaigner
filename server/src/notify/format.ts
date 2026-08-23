// Ops-channel message formatting (AIC-118). Pure — no DB, no network — so the
// wording is unit-testable, which matters more here than it looks: this is the
// surface where a number that means one thing gets rendered as a sentence
// claiming another, twice this week already (AIC-116, AIC-117).
import { SUMMARY_HE } from "../services/action-history.js";

export interface ActionEvent {
  kind: "action";
  id: string;
  occurredAt: Date;
  actionType: string;
  what: string;
  why: string;
  targetMetaId: string | null;
  previousState: Record<string, unknown>;
  newState: Record<string, unknown>;
  approvedBy: string | null;
  humanInvolved: boolean;
  result: "success" | "failed";
  businessName: string | null;
  campaignName: string | null;
  // Whether this belongs to a seeded/integration-test account. The relay uses
  // it to decide what NOT to send; formatting ignores it.
  isTest: boolean;
}

export interface OpsEvent {
  kind: "ops";
  id: string;
  createdAt: Date;
  type: string;
  severity: "low" | "medium" | "high";
  detail: string;
  businessName: string | null;
  campaignName: string | null;
  isTest: boolean;
}

export type NotifiableEvent = ActionEvent | OpsEvent;

// Who actually did it. Mirrors actorOf() in action-history.ts, which is the
// customer-facing projection of the same two columns — same rule, said in the
// ops channel's own words rather than the customer's.
function actorLabel(e: ActionEvent): string {
  if (!e.humanInvolved) return "engine (automatic)";
  if (e.approvedBy === "customer") return "the customer";
  return e.approvedBy ? `us (${e.approvedBy})` : "us";
}

// A failure is always red. Otherwise the icon separates "someone turned
// something off" from "something was created or turned on", because that is
// the distinction an operator scanning the channel actually cares about.
const STOPPING = new Set([
  "pause_ad", "pause_ad_set", "pause_creative",
  "archive_ad", "archive_ad_set", "delete_ad", "delete_ad_set",
  "decrease_budget", "rollback_build",
]);

function icon(e: ActionEvent): string {
  if (e.result === "failed") return "🔴";
  if (STOPPING.has(e.actionType)) return "🟠";
  return "🟢";
}

// Internal action types have no SUMMARY_HE entry ON PURPOSE — they're filtered
// out of the customer's feed. They still belong in the ops channel, so they get
// their own labels here rather than falling through to a generic "change".
const OPS_ONLY_LABELS: Record<string, string> = {
  rollback_build: "ביטול בנייה שנכשלה (rollback)",
};

export function actionTypeLabel(actionType: string): string {
  return SUMMARY_HE[actionType] ?? OPS_ONLY_LABELS[actionType] ?? actionType;
}

const OPS_TYPE_LABELS: Record<string, string> = {
  meta_connection_failure: "Meta connection failure",
  campaign_not_delivering: "Campaign not delivering",
  campaign_rejected: "Campaign rejected by Meta",
  unusual_performance: "Unusual performance",
  recommendation_review: "Recommendation needs review",
  support_request: "Support request",
  missing_creative: "Missing creative",
  account_restriction: "Account restriction",
};

const SEVERITY_ICON: Record<string, string> = { low: "🔵", medium: "🟡", high: "🔴" };

// A status transition, when the row actually recorded one. previous_state and
// new_state are free-form JSONB, so this reads them defensively and says
// nothing rather than inventing a transition that isn't there.
function transition(prev: Record<string, unknown>, next: Record<string, unknown>): string | null {
  const from = typeof prev.status === "string" ? prev.status : null;
  const to = typeof next.status === "string" ? next.status : null;
  if (!from || !to || from === to) return null;
  return `${from} → ${to}`;
}

function who(businessName: string | null): string {
  return businessName ?? "unknown customer";
}

export function formatAction(e: ActionEvent): string {
  const lines = [
    `${icon(e)} ${actionTypeLabel(e.actionType)}${e.result === "failed" ? " — FAILED" : ""}`,
    `customer: ${who(e.businessName)}`,
  ];
  if (e.campaignName) lines.push(`campaign: ${e.campaignName}`);
  if (e.what) lines.push(`what: ${e.what}`);
  const t = transition(e.previousState, e.newState);
  if (t) lines.push(`status: ${t}`);
  if (e.targetMetaId) lines.push(`object: ${e.targetMetaId}`);
  lines.push(`by: ${actorLabel(e)}`);
  // `why` is the customer-facing reason string; it's the most useful single
  // line when triaging, so it goes last where the eye lands after the facts.
  if (e.why) lines.push(`why: ${e.why}`);
  return lines.join("\n");
}

export function formatOps(e: OpsEvent): string {
  const lines = [
    `${SEVERITY_ICON[e.severity] ?? "🟡"} ${OPS_TYPE_LABELS[e.type] ?? e.type} [${e.severity}]`,
    `customer: ${who(e.businessName)}`,
  ];
  if (e.campaignName) lines.push(`campaign: ${e.campaignName}`);
  if (e.detail) lines.push(e.detail);
  return lines.join("\n");
}

export function formatEvent(e: NotifiableEvent): string {
  return e.kind === "action" ? formatAction(e) : formatOps(e);
}
