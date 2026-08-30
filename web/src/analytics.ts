import mixpanel from "mixpanel-browser";
import { strings } from "./strings";

// AIC-28 — the browser half of the measurement layer.
//
// SCOPE, DELIBERATELY NARROW. The activation funnel is measured on the SERVER
// (server/src/analytics/mixpanel.ts), at the code paths that perform the real
// state transitions. That is the PIS-27 lesson: milestones fired from the UI
// when a customer *reaches a screen* count intentions, not outcomes, and they
// over-reported activation for a month.
//
// So this file does only what the server cannot:
//   * identity — tie a browser session to the customer it belongs to
//   * page views — which screens get used, which never do
//
// It deliberately does NOT emit funnel events. If you are about to add
// `mixpanel.track("something_important")` here, check whether the server
// already knows it happened; it almost always does, and it knows it truthfully.

let ready = false;

/**
 * Called once at boot with the token from /api/config. No token (local dev,
 * any environment where it is unset) → every function here is a no-op, which
 * is how every other integration in this codebase behaves.
 */
export function initAnalytics(token: string | null, apiHost?: string | null): void {
  if (!token || ready) return;
  try {
    mixpanel.init(token, {
      // Must match the server's region — see MIXPANEL_API_HOST. Unset → US.
      ...(apiHost ? { api_host: apiHost } : {}),
      // Derived from the host rather than a build-time env flag: this repo's
      // web tsconfig has no vite/client types, and a hostname check needs no
      // build plumbing to be right.
      debug: /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname),
      // The SPA owns its own routing, so autocapture would record the first
      // load and nothing after it. `trackPage` is called from the router.
      track_pageview: false,
      persistence: "localStorage",
      // Customers are Israeli businesses, but the dashboard is a public URL
      // and we cannot prove no EU resident ever opens it. IP collection is the
      // one piece of personal data Mixpanel takes by default, and we have no
      // analytic use for it — turning it off removes the question entirely
      // rather than answering it with a consent banner nobody wants.
      ip: false,
    });
    ready = true;
  } catch {
    // Analytics must never break the app it measures.
  }
}

/**
 * Tie this browser to the CUSTOMER, not the login.
 *
 * One profile per business is the right subject for this product: a customer
 * is an account with a campaign, and its several logins are the same subject.
 * It also matches the server's `distinct_id`, so browser and server events
 * land on one profile instead of two halves of a funnel that never join.
 *
 * Never the email — emails change, ids do not.
 */
export function identifyCustomer(customerId: string | null): void {
  if (!ready || !customerId) return;
  try {
    mixpanel.identify(customerId);
  } catch {
    /* ignore */
  }
}

/**
 * On logout. Without this, the next person to sign in on the same device
 * inherits the previous customer's distinct_id — their events merge into
 * someone else's profile. That is a privacy incident, not just bad data.
 */
export function resetAnalytics(): void {
  if (!ready) return;
  try {
    mixpanel.reset();
  } catch {
    /* ignore */
  }
}

/**
 * A screen view. Takes the ROUTE PATTERN, never the resolved URL: a path like
 * `/app/recommendations/9f3c…` would put a real recommendation id into an
 * event property, and ids of customer-owned objects do not belong there.
 */
export function trackPage(routePattern: string): void {
  if (!ready) return;
  try {
    mixpanel.track("page_viewed", { route: routePattern });
  } catch {
    /* ignore */
  }
}

/** A named product event from the browser. snake_case, past tense. */
export function trackEvent(event: string, props: Record<string, string | number | boolean> = {}): void {
  if (!ready) return;
  try {
    mixpanel.track(event, props);
  } catch {
    /* ignore */
  }
}

/*
 * Every fixed UI string in the app, flattened once.
 *
 * THIS IS WHAT MAKES A READABLE CLICK LABEL SAFE. The rule was never "text is
 * forbidden" — it is "CUSTOMER CONTENT is forbidden": ad headlines, business
 * names, audience labels. Our own copy is not customer content, and it is all
 * in strings.ts.
 *
 * So a button's text may be used as its label if and only if that exact text
 * is one of our strings. A dynamic label — an ad headline rendered into a row,
 * a business name — cannot be in this set, so it falls through and is never
 * sent. The check is the safety property, not a heuristic about it.
 *
 * The first version refused all text and produced labels like
 * `button.btn.btn-primary`, which is safe and useless.
 */
const UI_TEXTS: Set<string> = (() => {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const t = v.trim();
      // Long strings are body copy, not control labels — no value as a label
      // and more chance of colliding with something dynamic.
      if (t && t.length <= 40) out.add(t);
    } else if (v && typeof v === "object") {
      for (const inner of Object.values(v as Record<string, unknown>)) walk(inner);
    }
  };
  walk(strings.he);
  return out;
})();

/** Collapse whitespace so "שמירה\n " matches the string "שמירה". */
function normalizeText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/*
 * A readable label that still cannot carry customer content.
 *
 * In priority order:
 *   1. `data-track` — an explicit, stable name. Best, and survives copy edits.
 *   2. the element's own text, ONLY if it is a known UI string (see UI_TEXTS).
 *   3. `aria-label`, same restriction.
 *   4. the destination, for links.
 *   5. a structural descriptor — the last resort, not the default.
 */
type LabelSource = "explicit" | "ui_text" | "aria" | "href" | "structural";

function clickLabel(el: Element): { label: string; source: LabelSource } {
  const explicit = el.getAttribute("data-track");
  if (explicit) return { label: explicit, source: "explicit" };

  const text = normalizeText(el);
  if (text && UI_TEXTS.has(text)) return { label: text, source: "ui_text" };

  // Icon-only controls (the mobile menu, the info affordances) have no text at
  // all; their aria-label IS their name, and it comes from the strings file
  // like everything else.
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria && UI_TEXTS.has(aria)) return { label: aria, source: "aria" };

  const href = el.getAttribute("href");
  if (href && href.startsWith("/")) {
    return { label: `link:${href.replace(/\/[0-9a-f-]{20,}/gi, "/:id")}`, source: "href" };
  }
  if (href) return { label: "external_link", source: "href" };

  // Class names are ours (ui.css), not content. Reached only when a control
  // has no stable name and no recognisable copy — worth adding `data-track` to.
  const cls = (el.className || "").toString().trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
  return { label: cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase(), source: "structural" };
}

let clicksWired = false;

export function initClickTracking(currentRoute: () => string): void {
  if (clicksWired) return;
  clicksWired = true;
  document.addEventListener(
    "click",
    (e) => {
      if (!ready) return;
      const el = (e.target as Element | null)?.closest?.("a,button");
      if (!el) return;
      try {
        // Computed together, never separately: an earlier version derived the
        // label in one place and its source in another, and they disagreed —
        // an aria-labelled control reported `[structural] תפריט`, which is
        // exactly the confusion label_source exists to remove.
        const { label, source } = clickLabel(el);
        mixpanel.track("element_clicked", {
          label,
          // How the name was obtained. Lets a report separate "this control is
          // used" from "something round here was clicked", and shows which
          // controls are still worth a data-track.
          label_source: source,
          route: currentRoute(),
          element: el.tagName.toLowerCase(),
        });
      } catch {
        /* ignore */
      }
    },
    // Capture: a handler that stops propagation, or a link that navigates
    // away, must not cost us the event.
    true,
  );
}
