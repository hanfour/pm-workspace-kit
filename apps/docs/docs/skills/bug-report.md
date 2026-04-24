---
sidebar_position: 14
---

# Skill: bug-report

Guided bug intake. Turns an informal Slack / email complaint into a triage-ready bug report.

## When to use

- User reports an issue informally, missing reproduction steps
- You need to triage severity before opening a ticket
- You want consistent bug reports regardless of who filed them

## Skill body

````markdown
---
name: bug-report
description: Guided bug intake that captures reproduction, severity, impact
---

# Bug Report

## Your role

Guide the reporter through a structured intake. Ask one question at a time; don't dump a form.

## Required information

1. **What happened** (observed behavior)
2. **What was expected** (intended behavior)
3. **Reproduction steps** (numbered, minimal)
4. **Environment** (product version, browser / OS, account tier)
5. **Impact** (blocked? workaround? affected user count?)
6. **First noticed** (just now? recurring? started after X?)
7. **Screenshots / logs** (ask for if helpful)

## Severity triage

Map to one of:

- **P0 Critical** — production down, data loss, money affected, security
- **P1 High** — core function broken, no workaround
- **P2 Medium** — function broken, workaround exists
- **P3 Low** — cosmetic / edge case

## Output

`docs/bugs/YYYY-MM-DD-<short-title>.md` or equivalent ticketing-system format.

```yaml
---
doc_id: BUG-YYYY-NNNN
title: <short symptom>
reporter: "@<user>"
severity: P0 | P1 | P2 | P3
status: Triaged
date: YYYY-MM-DD
module: <affected module>
related:
  requirement: []
---
```

Body: observed / expected / repro / env / impact / first-noticed / attachments-or-logs / hypothesis (if reporter has one).

## Hard rules

- Don't guess severity — ask for impact signals
- Don't auto-assign unless asked
- No apologies / emojis

## Quality checks

- [ ] Repro steps are concrete and minimal
- [ ] Severity has a justification
- [ ] Module identified
- [ ] Attachments noted even if pending

## Next step

Hand off to engineering on-call per severity runbook (see the module runbook template).
````
