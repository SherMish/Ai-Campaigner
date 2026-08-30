import mixpanel from "mixpanel-browser";

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
export function initAnalytics(token: string | null): void {
  if (!token || ready) return;
  try {
    mixpanel.init(token, {
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
 * Delegated click tracking for the signed-in app.
 *
 * THE LABEL IS NEVER THE ELEMENT'S TEXT. In here the text is customer content:
 * ad headlines, business names, audience labels, recommendation copy. Sending
 * it would put customer data into event properties, which is the one thing the
 * server tracker's scrubber exists to prevent — and the browser has no
 * scrubber. So a label is either an explicit `data-track` attribute, or a
 * structural descriptor derived from the element's own classes and role.
 *
 * The cost is that un-annotated buttons report as `button.btn-primary` rather
 * than something readable. That is the right trade: an unreadable label is a
 * nuisance, a leaked ad headline is a privacy problem. Add `data-track` to the
 * controls worth naming.
 */
function clickLabel(el: Element): string {
  const explicit = el.getAttribute("data-track");
  if (explicit) return explicit;
  const href = el.getAttribute("href");
  if (href && href.startsWith("/")) return `link:${href.replace(/\/[0-9a-f-]{20,}/gi, "/:id")}`;
  if (href) return "external_link";
  // Class names are ours (ui.css), not content — safe and reasonably telling.
  const cls = (el.className || "").toString().trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
  return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
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
        mixpanel.track("element_clicked", { label: clickLabel(el), route: currentRoute() });
      } catch {
        /* ignore */
      }
    },
    // Capture: a handler that stops propagation, or a link that navigates
    // away, must not cost us the event.
    true,
  );
}
