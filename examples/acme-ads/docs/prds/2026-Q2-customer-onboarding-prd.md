---
doc_id: PRD-2026-0001
title: Self-service customer onboarding (AcmeAds example)
owner: "@jane-pm"
status: Approved
date: 2026-04-15
related:
  requirement: [REQ-2026-0042]
  plan: []
  spec: [SPEC-2026-0003]
  architecture: []
  adr: [ADR-0004]
  module: [crm.customer]
  confluence_page_id: null
---

# Self-service customer onboarding

## 1. Context

Today, onboarding an AcmeAds advertiser takes 3–5 business days because a sales engineer walks every customer through account setup, billing terms, and tracker install. This PRD proposes a self-service flow for the bottom 60% of new signups (self-serve tier), freeing the sales engineers for standard and enterprise tier deals.

## 2. Problem statement

**As a** small-business advertiser (≤ $5k/mo estimated spend),
**I want to** sign up and launch my first campaign without a scheduled call,
**so that** I can test AcmeAds in the same afternoon I discover the product.

## 3. Goals

| Goal | Metric | Target |
|---|---|---|
| Self-serve signup rate | % new customers completing onboarding without sales contact | ≥ 50% |
| Time to first campaign | Median signup-to-first-impression | ≤ 30 min |
| Sales engineer load | Hours / week spent on bottom-tier onboarding | ≤ 5 (from 20) |
| Fraud rate | % self-serve signups flagged within 30 days | ≤ 2% |

## 4. Non-goals

- Enterprise onboarding (remains sales-assisted)
- Billing method changes post-signup (separate PRD)
- White-label / reseller flows

## 5. User stories

### US-1: Signup with email + company

The user enters email, company name, and tax ID. System creates a `Customer` row with status=`active`, tier=`self_serve`. Confirmation email dispatched within 10s.

**Acceptance criteria:**
- Tax ID validated via external registry API
- Duplicate tax ID → soft-merge prompt, not hard-block
- Primary `Contact` auto-created with role=`executive`

### US-2: Add payment method

Stripe card element. On success, `Contract` row created with `monthly_minimum_usd=0`, `signed=true`, `start_date=today`.

**Acceptance criteria:**
- Card tokenized; no raw PAN touches AcmeAds servers
- Failed card → user sees retry UI; no Customer row created if first payment attempt fails

### US-3: First campaign launch

User follows in-app walkthrough to create a Campaign. On campaign `status=active`, trigger `customer.onboarded_at` timestamp.

## 6. Flows

```mermaid
sequenceDiagram
  actor U as User
  participant W as Web (Next.js)
  participant A as API (Go)
  participant S as Stripe
  participant E as Tax registry

  U->>W: Submit signup form
  W->>A: POST /customers
  A->>E: Verify tax_id
  E-->>A: OK
  A-->>W: Customer + session
  U->>W: Enter card
  W->>S: Tokenize
  S-->>W: token
  W->>A: POST /contracts with token
  A->>S: Create customer + setup intent
  S-->>A: success
  A-->>W: Contract created
  U->>W: Create first Campaign
  W->>A: POST /campaigns
  A-->>U: Active; redirect to analytics
```

## 7. Data model

New: `signup_events` table (attempt-level log for funnel analysis).
Modified: `customer.onboarded_at` column added to existing `customer` table.
Unchanged: `contract`, `contact` tables (already fit).

See [`ontology/systems/crm.yaml`](../../ontology/systems/crm.yaml) for field-level detail.

## 8. Cross-module impact

- **billing**: receives `customer.created` event with `tier=self_serve` → dispatches welcome invoice sequence
- **campaigns**: receives customer id for attribution scoping
- **crm.customer**: entity changes documented above

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tax ID registry down | M | P2 | Queue verify + retry; allow provisional status |
| Fraudulent self-signup | M | P1 | Card-based verification + first-24h spend cap at $50 |
| Billing edge case (tax/region) | L | P2 | Fallback to manual invoicing for out-of-scope regions |

## 10. Rollout

- Week 1: beta cohort (50 invited users, existing leads)
- Week 2–3: 10% of new signups A/B
- Week 4: 100% self-serve path

Feature flag: `signup.self_serve.enabled`. Kill-switch via flag flip.

## 11. Open questions

- [ ] Refund flow for self-cancel within 7 days — separate PRD or included here?
- [ ] Multi-seat at self-serve tier — v2 or never?
