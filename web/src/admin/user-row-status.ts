export interface UserConnectionSummary {
  customerId: string | null;
  connectionReadiness: "no_campaign" | "not_launched" | "missing_page" | "connection_issue" | null;
}

// A fully-connected user (real business, campaign active, connection
// healthy, every asset present — connectionReadiness === null) must never be
// offered the onboarding wizard again: provisionConnection always INSERTs a
// new connection/ad_account/campaign trio, never upserts, so re-running it
// on an already-working customer creates a duplicate, not a refresh. Anyone
// short of that — no business yet, or a business with any readiness gap —
// still needs the wizard to finish or fix it.
export function offersOnboarding(row: UserConnectionSummary): boolean {
  if (!row.customerId) return true;
  return row.connectionReadiness !== null;
}
