# Content Studio

**Status:** live — internal Ads Agent operators can produce branded Hebrew Instagram carousels and export them as PNG files without a design tool or backend job.

**Source of truth:** `web/src/admin/AdminContentStudio.tsx`, `web/src/admin/content-studio.ts`, `web/src/admin/content-studio-renderer.ts`, `web/src/admin/content-studio.css`, `web/src/strings.ts`, `web/src/App.tsx`, `web/src/admin/AdminSidebar.tsx`.

**Lock-in tests:** `web/src/admin/content-studio.test.ts` pins the three formats, their distinct hook styles, hook-first/CTA-last structure, the checklist's exact three-check sequence, Instagram dimensions, text validation, optional source field, the signal format's exact label/content hierarchy, the per-template JSON contract/import validation and deterministic export filenames. `web/src/admin/content-studio-renderer.test.ts` pins true badge-symbol and hook-label centering, the signal question's center/footer clearance, content-fit hook tags and the CTA's readable text column/no-duplicate-logo geometry. Browser verification covers the rendered compositions, JSON copy/paste and automatic template switching, safe import rejection, template switching, image insertion/removal, successful PNG generation and the canvas's exact 1080×1350 dimensions.

---

## How it works today

`/admin/content-studio` is an internal organic-marketing tool inside the authenticated admin console. It does not read customer, campaign or Meta data and does not write to the server. A carousel exists only in the browser while the operator is editing it.

The operator chooses one of three editorial formats:

1. **Myth → reality** — corrects a belief that causes a small-business owner to make a poor advertising decision.
2. **One useful signal / “Did you know?”** — turns one metric, fact or behavior into a simple business implication. It provides a source/qualification field so an external statistic is never presented without context.
3. **Practical teardown / checklist** — gives the owner three short checks before a decision that could increase spend.

These are different editorial jobs and use three visibly different opening compositions: myth opens on ink with orange/indigo disruption, signal opens on indigo with an orange question motif, and checklist opens on cream with a numbered tile stack. Hook slides do not carry a small top-right eyebrow; the central hook is the only message competing for attention. Each starts from useful Hebrew sample copy written for Ads Agent's Israeli small-business ICP. Every generated carousel ends with a soft Ads Agent CTA; the CTA is built by the template and cannot be moved earlier or accidentally removed. All formats stay below Instagram's ten-slide carousel limit.

## Editing and validation

The editor exposes structured fields tied to their real slide. Focusing a field selects that slide in the preview. Character limits are declared per field, visible while typing, and enforced before export. A required blank or overlong field disables export and names the problem instead of silently clipping text in the image.

The same fields can be filled in one operation through the JSON importer. Each template exposes a copyable, human-readable JSON contract containing `template`, `name` and that template's stable content keys. Pasting a valid object selects the template named in the JSON and fills every text field while preserving any images already attached to that template. Import is atomic: malformed JSON, unsupported templates, missing required values, non-text values, unknown keys (including spelling mistakes), and text that exceeds a slide's limit are rejected before any current draft changes.

Every non-CTA slide accepts an optional PNG or JPEG. Images are read locally as data URLs, can be replaced or removed, and use a center-crop cover treatment so their aspect ratio is never stretched. Hook images become full-bleed backgrounds beneath a legibility overlay; content-slide images use a dedicated image-and-copy composition. CTA slides always use the controlled brand composition.

## Renderer and export

The preview is the actual output canvas, not an HTML approximation. `drawCarouselSlide()` owns both preview and export, so those surfaces cannot drift. Every canvas is exactly 1080×1350 (Instagram portrait 4:5), uses the Ads Agent palette and shipped icon, and renders Hebrew through the browser canvas with RTL direction.

The operator can download the selected slide or every slide in order. Filenames are deterministic: `ads-agent-<carousel-name>-01.png`, `-02.png`, and so on. Export happens entirely in the browser using PNG blobs. “Download all” may trigger the browser's multiple-download permission; the UI says so after completion.

## Brand and editorial constraints

The renderer uses the production palette (`#171717`, `#F7F2EA`, `#EDE6DA`, `#FF5A36`, `#2FA36B`, `#665CFF`), Rubik/IBM Plex Mono typography and `/favicon.png`. Opening slides are intentionally high-contrast and sparse; content slides hold one idea. Hook labels size themselves to their copy and center it vertically rather than occupying a generic wide pill. The signal question motif stays above the footer and shares one geometric center with its question mark. The checklist's opening promise, three numbered tiles and three check slides are one locked sequence; its numbers and symbols are centered from the badge geometry rather than by eye. The signal metric slide presents the entered metric once without inserting a second orange unit label. CTA slides mention Ads Agent gently, use one text brand marker rather than a duplicate image logo, and keep all dark copy outside the dark decorative shape.

V1 deliberately does not generate claims, statistics or copy with an LLM. The operator is responsible for the facts entered, and the source/qualification field exists for claims that need one. Saving drafts, generating captions, importing business context and posting directly to Instagram are not part of this feature today.
