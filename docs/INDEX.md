# docs/INDEX.md — routing table

The map from a **code area** to the one doc that **owns** it. Before changing any
area, open its owning doc first. When you add, rename, or remove a feature doc,
update the matching row here in the same unit of work.

See also: [STATE.md](STATE.md) (dated changelog) · [features/_TEMPLATE.md](features/_TEMPLATE.md) (house shape for a new owning doc).

| Code area | Owning doc |
| --- | --- |
| Repo scaffold, build, migration runner, CI/Railway wiring | [features/scaffold.md](features/scaffold.md) |
| DB schema — the 10 P0 entities, migrations, enums, seed | [DATA_MODEL.md](DATA_MODEL.md) |
| Meta-side setup — Business/app/System User, token, asset assignment | [META_SETUP.md](META_SETUP.md) |
| Meta connection, access-health, execution-halt safety rule | [features/meta-connection.md](features/meta-connection.md) |
| Insights ingestion → insight_snapshot, scheduler | [features/insights-ingestion.md](features/insights-ingestion.md) |
| Ad-set delivery health — not-delivering/disapproved detection, needs-attention | [features/delivery-health.md](features/delivery-health.md) |
| Lead / CPL / metric definitions | [METRICS.md](METRICS.md) |
| Admin dogfood readout (screen + API) | [features/dogfood-readout.md](features/dogfood-readout.md) |
| Recommendation engine — state machine, rules, staleness, explainer | [features/recommendation-engine.md](features/recommendation-engine.md) |
| Rule thresholds + LLM boundary | [RULES.md](RULES.md) |
| Approval & safe execution — budget safety, outbox, pipeline | [features/safe-execution.md](features/safe-execution.md) |
| Manual object controls — pause/resume (all users), archive/delete (admin) | [features/manual-controls.md](features/manual-controls.md) |
| Action history surface (audit trail + condensed projection) | [features/action-history.md](features/action-history.md) |
| Ops console — customers, needs-attention, review, billing | [features/ops-console.md](features/ops-console.md) |
| Landing page (static marketing, Ads Manager brand) | [features/landing.md](features/landing.md) |
| Customer app — auth, onboarding, connect, home, recommendations, settings (frontend) | [features/customer-app.md](features/customer-app.md) |
| Customer auth — email+password, JWT sessions (backend) | [features/customer-auth.md](features/customer-auth.md) |
| Customer overview — Home/Settings data API, homeState, lead-quality (backend) | [features/customer-overview.md](features/customer-overview.md) |
| Customer recommendations — approve/dismiss over the safe-execute pipeline | [features/customer-recommendations.md](features/customer-recommendations.md) |
| Campaign builder (P1) — recommended defaults, create-writes, guided UI, launch gate | [features/campaign-builder.md](features/campaign-builder.md) |
