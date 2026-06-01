---
doc_id: PRD-2026-0003
title: Customer data dedup for onboarding (AcmeAds example)
owner: "@jane-pm"
status: Draft
date: 2026-05-22
related:
  requirement: [REQ-2026-0052]
  plan: []
  spec: []
  architecture: []
  adr: [ADR-0004]
  module: [crm.customer]
  confluence_page_id: null
---

# Customer data dedup for onboarding

## Problem

Self-service onboarding ([PRD-2026-0001](./2026-Q2-customer-onboarding-prd.md))
lets new advertisers register themselves — but some are already customers under a
slightly different name or email, creating duplicate CRM profiles that split
spend history and break revenue attribution.

## Goals

- Detect a duplicate at registration: normalized email + company tax id as the
  match key.
- On a match, merge into the existing `crm.customer` profile rather than creating
  a new one; conflicting fields take the most recent self-service submission.

## Non-goals

- No retroactive de-dup of the historical CRM (that's the batch migration job in
  the `crm.customer` module playbook).
- No fuzzy/ML matching in v1 — exact normalized key only.

## Success metrics

- Duplicate-profile rate among self-service signups < 1%.
- No revenue-attribution tickets caused by split profiles after launch.

## Open questions

- Tax id is optional for some regions — what's the fallback match key there?
