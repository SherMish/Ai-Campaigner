import { type Placement } from "@aic/shared";

// AIC-177 — why a placement option cannot be chosen.
//
// Same shape and the same reason as builder-gates.ts: this repo's web tests
// run in `environment: "node"`, so a rule living inside a React component is
// reachable by no test at all — which is exactly how AIC-173 shipped a button
// that refused in silence.
//
// "Irrelevant → unclickable, with the reason next to it" is the house rule
// (AIC-155/158/161/163). An Instagram option that simply does nothing when no
// Instagram account is connected is the worst version: the customer picks it,
// nothing happens, and the product never says why.

export type PlacementBlocker = "no_instagram";

/**
 * Null when this option is choosable.
 *
 * ONLY Instagram can be blocked, deliberately. A Facebook placement needs a
 * Page, and a Page is already required to create any ad set at all — so a
 * "no_page" variant could never be produced, and inventing it would be a claim
 * the code makes about itself that is not true (the AIC-172 lesson).
 */
export function placementBlocker(
  placement: Placement,
  ctx: { hasInstagram: boolean },
): PlacementBlocker | null {
  if (placement === "instagram" && !ctx.hasInstagram) return "no_instagram";
  return null;
}

/**
 * The placement to fall back to when the current choice became unavailable —
 * a customer picks Instagram, then their Instagram disconnects. Returns null
 * when the current choice is still fine.
 *
 * Never leaves the form holding a value the server will refuse: the submit
 * would fail with a message about something the customer cannot see from here.
 */
export function placementFallback(
  current: Placement,
  ctx: { hasInstagram: boolean },
): Placement | null {
  return placementBlocker(current, ctx) ? "advantage" : null;
}
