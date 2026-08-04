# Failure log

Date | Title | What happened / fix | Tooling catches it?

---

2026-08-03 | Support path shipped broken (deploy skew) | Local verify passed while production ran older client code. Caught by manual live testing, not by tooling. Fix: support-type short-circuits before validation; `npm run verify-ship` compares deployed bundle against local `SHIP_MARKERS`. | Yes (`verify-ship`)
