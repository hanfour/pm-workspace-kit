<!--
This is the PR template for the pm-workspace-kit repo itself.
For downstream projects adopting the kit, see docs/handoff/pr-template.md.
-->

## Summary

<!-- 1-3 sentences: what + why. -->

## Change type

- [ ] feat (new capability)
- [ ] fix (bug)
- [ ] docs
- [ ] refactor
- [ ] test
- [ ] chore / build / ci

## Checklist

- [ ] Matches project conventions
- [ ] Traceability check passes locally: `npm run traceability:check`
- [ ] `npm run build` succeeds (if touching docs site or config)
- [ ] If adding a new tracked doc type, documented it in `docs/concepts/traceability.md`
- [ ] Not introducing organization-specific content (this is a public kit; keep it generic)

## Notes for reviewers

<!-- Context, tradeoffs, follow-ups -->
