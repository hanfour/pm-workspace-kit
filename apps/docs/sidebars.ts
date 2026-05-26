import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    "getting-started",
    {
      type: "category",
      label: "Concepts",
      collapsed: false,
      items: [
        "concepts/traceability",
        "concepts/definitions-of-ready-done",
        "concepts/adr-patterns",
        "concepts/strangler-fig",
      ],
    },
    {
      type: "category",
      label: "Guides",
      items: [
        "guides/traceability-matrix",
        "guides/confluence-sync",
        "guides/authoring-north-star",
        "guides/handoff-to-implementation",
      ],
    },
    {
      type: "category",
      label: "Templates",
      items: [
        "templates/adr-template",
        "templates/module-playbook-template",
        "templates/prd-frontmatter",
      ],
    },
    {
      type: "category",
      label: "Handoff Kit",
      items: [
        "handoff/overview",
        "handoff/pr-template",
        "handoff/code-review-checklist",
        "handoff/module-runbook-template",
        "handoff/monitoring-dashboard-spec",
        "handoff/readiness-checklist",
      ],
    },
    {
      type: "category",
      label: "Methodology ADRs",
      items: [
        "adr/README",
        "adr/strangler-fig-protocol",
        "adr/dev-harness",
        "adr/product-decision-log",
      ],
    },
    {
      type: "category",
      label: "Skills Catalog",
      items: [
        "skills/overview",
        "skills/requirement-intake",
        "skills/generate-prd",
        "skills/create-prd",
        "skills/write-spec",
        "skills/publish-to-confluence",
        "skills/brainstorm-new",
        "skills/brainstorm-existing",
        "skills/research",
        "skills/gather-requirements",
        "skills/decompose",
        "skills/prioritize",
        "skills/roadmap",
        "skills/bug-report",
        "skills/create-pptx",
      ],
    },
    {
      type: "category",
      label: "Example: AcmeAds",
      items: ["examples/acme-ads"],
    },
    {
      type: "category",
      label: "Gateway (v0.7)",
      collapsed: false,
      items: [
        "gateway/lifecycle",
        "adr/pmk-gateway-slack",
        "prds/2026-04-27-pmk-gateway-prd",
        "prds/2026-05-gateway-onboarding-prd",
      ],
    },
    {
      type: "category",
      label: "Project Planning",
      collapsed: true,
      items: [
        "prds/2026-04-24-desktop-app-prd",
        "adr/desktop-framework",
        "plans/2026-04-24-desktop-app-sprint-plan",
      ],
    },
    "changelog",
  ],
};

export default sidebars;
