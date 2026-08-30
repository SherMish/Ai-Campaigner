/*
 * AIC-28 — analytics for the STATIC surfaces: the landing page and /guides.
 *
 * These are vanilla HTML outside the React SPA, so they cannot import
 * web/src/analytics.ts. This is their equivalent.
 *
 * WHY MIXPANEL'S LIBRARY AT ALL, RATHER THAN A 20-LINE fetch() TO /track.
 * The point of measuring the landing page is to join it to what happens next:
 * someone reads a guide, signs up, becomes a customer. That join only works if
 * these pages and the SPA share ONE anonymous distinct_id, and the SPA uses
 * mixpanel-browser, which owns that id in its own localStorage format. Rolling
 * our own would either invent a second identity — breaking the exact funnel
 * this exists for — or depend on their storage layout, which is theirs to
 * change.
 *
 * WHY THE CDN BUILD AND NOT A BUNDLE OF THE NPM PACKAGE. Measured both:
 * bundling the package is 126 KB gzipped (it includes the session recorder),
 * Mixpanel's CDN build is 33 KB. These are SEO pages; 93 KB matters more here
 * than the third-party request does.
 */
(function () {
  "use strict";

  var LIB = "https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js";

  function pageType() {
    var p = window.location.pathname;
    if (p === "/" || p === "/index.html") return "landing";
    if (p.indexOf("/guides") === 0) return "guide";
    if (p.indexOf("/terms") === 0 || p.indexOf("/privacy") === 0) return "legal";
    return "other";
  }

  // The guide slug is a real dimension (which guide earns readers) and is OUR
  // content, not customer data. From the path, never the title — titles are
  // content and change freely.
  function pageSlug() {
    var parts = window.location.pathname.split("/").filter(Boolean);
    return parts.length > 1 ? decodeURIComponent(parts[parts.length - 1]) : "index";
  }

  /*
   * A click label that can never leak content.
   *
   * `data-track` when present, else the element's role and destination —
   * NEVER its text. Here the text is marketing copy and harmless; in the app
   * the same habit would send ad headlines and business names. One rule for
   * both surfaces beats a special case that gets copied to the wrong place.
   */
  function labelFor(el) {
    var explicit = el.getAttribute("data-track");
    if (explicit) return explicit;
    var href = el.getAttribute("href") || "";
    if (href.indexOf("wa.me") > -1) return "whatsapp";
    if (href.indexOf("mailto:") === 0) return "email_link";
    if (href.charAt(0) === "/" || href.charAt(0) === "#") return "link:" + href;
    if (href) return "external_link";
    return el.tagName.toLowerCase();
  }

  /*
   * Always resolve window.mixpanel AT CALL TIME. Never hold a reference.
   *
   * The stub and the real library are two different objects: the stub queues
   * calls, and when the library arrives it REPLACES window.mixpanel and
   * flushes that queue once. Anything still holding the stub afterwards pushes
   * into a queue nobody will ever read again.
   *
   * That is not theoretical — the first version passed the object into this
   * function, and the page view worked (it fired before the swap) while every
   * click afterwards vanished silently. Exactly the shape of bug that looks
   * like working analytics until you go looking for the events.
   */
  function send(event, props) {
    var mp = window.mixpanel;
    if (mp && typeof mp.track === "function") mp.track(event, props);
  }

  function start() {
    var base = { page_type: pageType(), page_slug: pageSlug() };
    send("page_viewed", {
      page_type: base.page_type,
      page_slug: base.page_slug,
      route: window.location.pathname,
    });
    document.addEventListener(
      "click",
      function (e) {
        var el = e.target && e.target.closest ? e.target.closest("a,button") : null;
        if (!el) return;
        send("element_clicked", {
          page_type: base.page_type,
          page_slug: base.page_slug,
          label: labelFor(el),
        });
      },
      // Capture: a handler that stops propagation, or a link that navigates
      // away, must not cost us the event.
      true,
    );
  }

  fetch("/api/config")
    .then(function (r) {
      return r.json();
    })
    .then(function (cfg) {
      if (!cfg || !cfg.mixpanelToken) return; // unset environment → no-op

      // 1. The stub. Defines window.mixpanel and queues calls until the real
      //    library arrives and flushes them.
      var stub = document.createElement("script");
      stub.src = "/vendor/mixpanel-snippet.min.js";

      stub.onload = function () {
        if (!window.mixpanel || !window.mixpanel.init) return;

        // 2. The library, ALWAYS over https.
        //
        //    The stub picks its own URL from the page's protocol, so on an
        //    http page it requests http://cdn.mxpnl.com — which Mixpanel does
        //    not serve. The library then never loads, every call sits in the
        //    queue forever, and nothing reports an error. Invisible in
        //    production (https) and total on localhost: a bug you cannot
        //    reproduce where you develop. Hit exactly this while building it.
        //
        //    Loading it ourselves over https makes both protocols behave the
        //    same. The stub's own request may still fail; harmless, because
        //    whichever copy arrives first flushes the same queue.
        var lib = document.createElement("script");
        lib.src = LIB;
        lib.async = true;
        document.head.appendChild(lib);

        window.mixpanel.init(cfg.mixpanelToken, {
          track_pageview: false, // sent explicitly above, with page_type
          persistence: "localStorage",
          // IP is the only personal datum Mixpanel takes by default and we
          // have no analytic use for it. Same posture as the SPA.
          ip: false,
        });
        start();
      };

      document.head.appendChild(stub);
    })
    .catch(function () {
      /* analytics must never break a marketing page */
    });
})();
