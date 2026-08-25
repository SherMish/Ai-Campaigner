# docs/INDEX.md — routing table

The map from a **code area** to the one doc that **owns** it. Before changing any
area, open its owning doc first. When you add, rename, or remove a feature doc,
update the matching row here in the same unit of work.

See also: [STATE.md](STATE.md) (dated changelog) · [POSTMORTEM-2026-08-19.md](POSTMORTEM-2026-08-19.md) (builder/Meta failure field guide) · [features/_TEMPLATE.md](features/_TEMPLATE.md) (house shape for a new owning doc).

| Code area | Owning doc |
| --- | --- |
| Repo scaffold, build, migration runner, CI/Railway wiring | [features/scaffold.md](features/scaffold.md) |
| DB schema — the 10 P0 entities, migrations, enums, seed | [DATA_MODEL.md](DATA_MODEL.md) |
| Meta-side setup — Business/app/System User, token, asset assignment | [META_SETUP.md](META_SETUP.md) |
| Meta connection, access-health, execution-halt safety rule | [features/meta-connection.md](features/meta-connection.md) |
| Insights ingestion → insight_snapshot, scheduler | [features/insights-ingestion.md](features/insights-ingestion.md) |
| Ad-set delivery health — not-delivering/disapproved detection, needs-attention | [features/delivery-health.md](features/delivery-health.md) |
| Lead-tracking health — declared lead definition vs Meta's ad-set config, needs-attention | [features/tracking-health.md](features/tracking-health.md) |
| CTA health — is the ad's button pointing anywhere? (AIC-128) | [features/cta-health.md](features/cta-health.md) |
| Ad-account health — can the account spend at all? (AIC-72) | [features/account-health.md](features/account-health.md) |
| Lead-event volume — pixel alive but the lead event stopped (AIC-91) | [features/event-volume.md](features/event-volume.md) |
| Over-count detection — are the leads inflated? (AIC-92) | [features/overcount.md](features/overcount.md) |
| Lead / CPL / metric definitions | [METRICS.md](METRICS.md) |
| Admin dogfood readout (screen + API) | [features/dogfood-readout.md](features/dogfood-readout.md) |
| Recommendation engine — state machine, rules, staleness, explainer | [features/recommendation-engine.md](features/recommendation-engine.md) |
| Feature layer — named windowed metrics the rules reason over | [FEATURES.md](FEATURES.md) |
| Rule thresholds + LLM boundary | [RULES.md](RULES.md) |
| Outcome measurement — did an executed recommendation actually help? | [features/outcome-measurement.md](features/outcome-measurement.md) |
| Approval & safe execution — budget safety, outbox, pipeline | [features/safe-execution.md](features/safe-execution.md) |
| Manual object controls — pause/resume (all users), archive/delete (admin) | [features/manual-controls.md](features/manual-controls.md) |
| Removed ads — the customer's "delete", and Meta's (AIC-128) | [features/removed-ads.md](features/removed-ads.md) |
| Orphaned creatives — the ones that never became ads (AIC-131) | [features/creative-reaper.md](features/creative-reaper.md) |
| Lead-quality attribution — audiences ranked on relevant leads (AIC-133) | [features/lead-quality-attribution.md](features/lead-quality-attribution.md) |
| Security posture — tenant isolation, authn/authz, TLS, rate limits | [features/security.md](features/security.md) |
| Profile quality gate — do we know enough to advertise? (AIC-132) | [features/profile-quality.md](features/profile-quality.md) |
| Action history surface (audit trail + condensed projection) | [features/action-history.md](features/action-history.md) |
| Ops console — customers, needs-attention, review, billing | [features/ops-console.md](features/ops-console.md) |
| Ops notifications — Telegram relay for changes, failures and errors | [features/notifications.md](features/notifications.md) |
| Landing page (static marketing, Ads Agent brand) | [features/landing.md](features/landing.md) |
| Guides / blog — static SEO pages at `/guides`, Markdown-authored | [features/guides-blog.md](features/guides-blog.md) |
| Customer app — auth, onboarding, connect, home, recommendations, settings (frontend) | [features/customer-app.md](features/customer-app.md) |
| Customer auth — email+password, JWT sessions (backend) | [features/customer-auth.md](features/customer-auth.md) |
| Customer overview — Home/Settings data API, homeState, lead-quality (backend) | [features/customer-overview.md](features/customer-overview.md) |
| State → copy mapping — the exhaustive copy maps that enforce "never blank" | [features/state-copy.md](features/state-copy.md) |
| Customer recommendations — approve/dismiss over the safe-execute pipeline | [features/customer-recommendations.md](features/customer-recommendations.md) |
| Campaign builder (P1) — recommended defaults, create-writes, guided UI, launch gate | [features/campaign-builder.md](features/campaign-builder.md) |
| Add content to an existing campaign — new ad/ad-set, destination shapes | [features/add-content.md](features/add-content.md) |
