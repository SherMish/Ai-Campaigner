// AIC-101 / AIC-99 — OUR Meta identity, in one place, from config.
//
// The value a customer needs during onboarding is the Business Portfolio ID.
// They add us as a partner **by ID, never by name** (docs/META_SETUP.md's
// naming trap: our portfolio and our app share a display name, and the rename
// to "Ads Agent" changes the name while the ID stays put). So the ID is the
// thing that must be correct and the name is decoration.
//
// Env-overridable with the real value as the default: this is a public
// identifier customers are literally told to type in, not a secret, so a
// hardcoded fallback is safe and keeps local/dev working without setup. What
// it must NOT be is duplicated into the frontend bundle — before this, it
// lived as a literal in web/src/strings.ts, which is exactly the "read from
// config, never hardcoded" AIC-101 calls out. The frontend now receives it
// from the server, so there is one definition to change.
export const OUR_BUSINESS_PORTFOLIO_ID =
  process.env.META_BUSINESS_PORTFOLIO_ID || "2491237118040524";

// Our System User — the identity that actually operates customer assets once
// they're assigned to it. Used as the default when provisioning a connection.
export const OUR_SYSTEM_USER_ID =
  process.env.META_SYSTEM_USER_ID || "122103498795426897";
