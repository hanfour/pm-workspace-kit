---
doc_id: PRD-2026-0002
title: Ad placement performance dashboard (AcmeAds example)
owner: "@jane-pm"
status: Draft
date: 2026-05-20
related:
  requirement: [REQ-2026-0051]
  plan: []
  spec: []
  architecture: []
  adr: [ADR-0004]
  module: []
  confluence_page_id: null
---

# Ad placement performance dashboard

## Problem

Account managers answer "how is my placement performing?" by hand-pulling the
`placement_daily` table and computing vCPM in a spreadsheet — slow, and easy to
get wrong (people divide revenue by *total* impressions instead of *viewable*).

## Goals

- One dashboard showing each placement's `PlacementRevenue`, viewable impressions,
  and vCPM, groupable by AdFormat.
- Number definitions match the PKB exactly — vCPM uses **viewable** impressions,
  not total.

## Non-goals

- No advertiser self-service login (that's the self-service onboarding scope —
  see [PRD-2026-0001](./2026-Q2-customer-onboarding-prd.md)).
- No historical recompute; read existing `placement_daily` rollups only.

## Success metrics

- Time for an AM to answer "what's this placement's vCPM" drops from minutes to
  seconds.
- Zero vCPM definition mismatches reported between the dashboard and finance.

## Open questions

- Which AdFormat groupings does sales actually use day-to-day?
