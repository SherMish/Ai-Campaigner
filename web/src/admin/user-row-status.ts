export interface UserConnectionSummary {
  customerId: string | null;
  connectionReadiness: "no_campaign" | "not_launched" | "missing_page" | "connection_issue" | "incomplete_config" | null;
}

// A fully-connected user (real business, campaign active, connection
// healthy, every asset present — connectionReadiness === null) must never be
// offered the onboarding wizard again: provisionConnection always INSERTs a
// new connection/ad_account/campaign trio, never upserts, so re-running it
// on an already-working customer creates a duplicate, not a refresh. Anyone
// short of that — no business yet, or a business with any readiness gap —
// still needs the wizard to finish or fix it.
//
// AIC-103: "incomplete_config" gets the SAME treatment as null, not the
// other three. It only ever fires once a real connection/ad-account/campaign
// trio already exists and is healthy — the ONE thing missing is a field on
// that existing campaign row, not a connection gap the wizard's (insert-only)
// step 4 could legitimately re-run. Offering the wizard here would create a
// duplicate trio, exactly the failure this function exists to prevent —
// there is deliberately no fix-it flow wired up yet for this specific case
// (a real gap, not an oversight: editing an existing campaign's fields has
// no admin surface at all today).
export function offersOnboarding(row: UserConnectionSummary): boolean {
  if (!row.customerId) return true;
  return row.connectionReadiness !== null && row.connectionReadiness !== "incomplete_config";
}
