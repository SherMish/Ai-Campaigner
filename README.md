# AI Campaigner

An affordable Meta campaign-management service for Israeli small businesses with
existing lead-generation campaigns. Customers connect their ad account and provide
their offer, copy, and creatives; the system monitors performance, explains results
in plain Hebrew, and recommends improvements — **any change to budget or delivery
requires the customer's explicit approval.** Humans handle onboarding, first-campaign
review, and support.

> **We manage your Meta advertising for you.** — no ₪1,000+ retainer.

## Start here

- **[CLAUDE.md](CLAUDE.md)** — operating rules for every session in this repo.
- **[docs/INDEX.md](docs/INDEX.md)** — routing table from a code area to its owning doc.
- **[docs/STATE.md](docs/STATE.md)** — dated changelog.

## Stack (target)

- **DB:** Neon (serverless Postgres), numbered-migration runner, dev branch for local/CI.
- **Deploy:** Railway, on green GitHub CI.
- Server API holds the DB connection and all authorization; no token reaches the client.

Backlog lives in Linear team **AIC** (AI Campaigner). This repo is scaffolded from
Pisga's proven stack; the stack scaffold (server/web/CI) lands after this governance
bootstrap.
