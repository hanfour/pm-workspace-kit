// packages/core/test/traceability.test.js
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  getDocType,
  getNested,
  validateDoc,
  buildGraph,
  inferVirtualKind,
  safeId,
  escapeLabel,
  mermaidLabel,
  renderFlatTable,
  renderSummary,
} = require("../src/traceability.js");

describe("getDocType", () => {
  it("extracts the prefix before the first dash", () => {
    assert.equal(getDocType("PRD-001"), "PRD");
    assert.equal(getDocType("SPEC-FIN-2"), "SPEC");
    assert.equal(getDocType("PLAN-2026-05"), "PLAN");
  });
  it("returns null for empty / missing doc_id", () => {
    assert.equal(getDocType(null), null);
    assert.equal(getDocType(undefined), null);
    assert.equal(getDocType(""), null);
  });
  it("coerces non-string doc_id", () => {
    assert.equal(getDocType(123), "123");
  });
});

describe("getNested", () => {
  it("resolves a dotted path", () => {
    const obj = { related: { prd: ["PRD-1"] } };
    assert.deepEqual(getNested(obj, "related.prd"), ["PRD-1"]);
  });
  it("returns undefined for a missing intermediate key without throwing", () => {
    assert.equal(getNested({}, "related.prd"), undefined);
    assert.equal(getNested({ related: null }, "related.prd"), undefined);
  });
  it("resolves a top-level key", () => {
    assert.equal(getNested({ title: "X" }, "title"), "X");
  });
});

describe("validateDoc", () => {
  it("fails on a YAML parse error, surfacing the first line", () => {
    const res = validateDoc({
      path: "docs/prds/bad.md",
      data: {},
      parseError: "bad indentation\n  at line 3",
    });
    assert.equal(res.ok, false);
    assert.equal(res.skipped, false);
    assert.match(res.errors[0], /YAML parse error: bad indentation/);
  });

  it("skips a doc with empty front-matter", () => {
    const res = validateDoc({ path: "x.md", data: {}, parseError: null });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, true);
  });

  it("skips a doc whose doc_id type has no required-field rule", () => {
    const res = validateDoc({
      path: "x.md",
      data: { doc_id: "HANDOFF-1", title: "t" },
      parseError: null,
    });
    assert.equal(res.skipped, true);
    assert.equal(res.ok, true);
  });

  it("skips a doc with front-matter but no doc_id", () => {
    const res = validateDoc({
      path: "x.md",
      data: { title: "just a note" },
      parseError: null,
    });
    assert.equal(res.skipped, true);
  });

  it("reports each missing required field for a PRD", () => {
    const res = validateDoc({
      path: "docs/prds/p.md",
      data: { doc_id: "PRD-1", title: "T" },
      parseError: null,
    });
    assert.equal(res.ok, false);
    assert.equal(res.skipped, false);
    assert.equal(res.type, "PRD");
    // owner, status, date, related.requirement all missing
    assert.ok(res.errors.includes("missing field: owner"));
    assert.ok(res.errors.includes("missing field: related.requirement"));
    assert.equal(res.errors.length, 4);
  });

  it("treats an empty-string field as missing", () => {
    const res = validateDoc({
      path: "docs/prds/p.md",
      data: {
        doc_id: "PRD-1",
        title: "T",
        owner: "",
        status: "Draft",
        date: "2026-01-01",
        related: { requirement: ["REQ-1"] },
      },
      parseError: null,
    });
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ["missing field: owner"]);
  });

  it("passes a fully-populated PRD", () => {
    const res = validateDoc({
      path: "docs/prds/p.md",
      data: {
        doc_id: "PRD-1",
        title: "T",
        owner: "hanfour",
        status: "Draft",
        date: "2026-01-01",
        related: { requirement: ["REQ-1"] },
      },
      parseError: null,
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, false);
    assert.deepEqual(res.errors, []);
  });

  it("validates SPEC against related.prd", () => {
    const res = validateDoc({
      path: "docs/specs/s.md",
      data: {
        doc_id: "SPEC-1",
        title: "T",
        owner: "o",
        status: "Draft",
        date: "2026-01-01",
        related: { prd: ["PRD-1"] },
      },
      parseError: null,
    });
    assert.equal(res.ok, true);
  });
});

describe("inferVirtualKind", () => {
  it("uses the doc-id prefix when the target looks like a doc id", () => {
    assert.equal(inferVirtualKind("adr", "ADR-7"), "ADR");
    assert.equal(inferVirtualKind("prd", "PRD-3"), "PRD");
    assert.equal(inferVirtualKind("requirement", "REQ-9"), "REQ");
  });
  it("falls back to the edge key for free-form targets", () => {
    assert.equal(inferVirtualKind("module", "billing-service"), "module");
    assert.equal(inferVirtualKind("architecture", "docs/arch/overview"), "architecture");
  });
});

describe("safeId / escapeLabel", () => {
  it("safeId replaces every non-alphanumeric char with underscore", () => {
    assert.equal(safeId("PRD-001.2"), "PRD_001_2");
    assert.equal(safeId("docs/arch/x"), "docs_arch_x");
  });
  it("escapeLabel neutralises quotes and brackets", () => {
    assert.equal(escapeLabel('a "b" [c]'), "a 'b' (c)");
  });
});

describe("mermaidLabel", () => {
  it("renders a virtual node as its escaped id only", () => {
    assert.equal(mermaidLabel({ virtual: true, id: "ADR-1", title: "x", status: "y" }), "ADR-1");
  });
  it("stacks id / title / status for a primary node", () => {
    const label = mermaidLabel({
      virtual: false,
      id: "PRD-1",
      title: "Login",
      status: "Draft",
    });
    assert.equal(label, "PRD-1<br/><i>Login</i><br/>[Draft]");
  });
});

describe("buildGraph", () => {
  const primary = [
    {
      id: "PRD-1",
      kind: "PRD",
      title: "T",
      status: "Draft",
      path: "docs/prds/p.md",
      related: { requirement: ["REQ-1"], adr: ["ADR-7"] },
      virtual: false,
    },
    {
      id: "SPEC-1",
      kind: "SPEC",
      title: "S",
      status: "Draft",
      path: "docs/specs/s.md",
      related: { prd: ["PRD-1"] },
      virtual: false,
    },
  ];

  it("creates virtual nodes for referenced-but-absent targets", () => {
    const g = buildGraph(primary);
    const ids = g.nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, ["ADR-7", "PRD-1", "REQ-1", "SPEC-1"]);
    const req = g.nodes.find((n) => n.id === "REQ-1");
    assert.equal(req.virtual, true);
    assert.equal(req.kind, "REQ");
  });

  it("does not duplicate an existing primary node as virtual", () => {
    const g = buildGraph(primary);
    const prdNodes = g.nodes.filter((n) => n.id === "PRD-1");
    assert.equal(prdNodes.length, 1);
    assert.equal(prdNodes[0].virtual, false); // stays primary even though SPEC-1 references it
  });

  it("emits an edge per related target with the edge type", () => {
    const g = buildGraph(primary);
    assert.deepEqual(
      g.edges.sort((a, b) => a.to.localeCompare(b.to)),
      [
        { from: "PRD-1", to: "ADR-7", type: "adr" },
        { from: "SPEC-1", to: "PRD-1", type: "prd" },
        { from: "PRD-1", to: "REQ-1", type: "requirement" },
      ].sort((a, b) => a.to.localeCompare(b.to)),
    );
  });

  it("skips null / empty / whitespace refs", () => {
    const g = buildGraph([
      {
        id: "PRD-9",
        kind: "PRD",
        title: "",
        status: "",
        path: "p.md",
        related: { requirement: [null, "", "   ", "REQ-2"] },
        virtual: false,
      },
    ]);
    assert.deepEqual(g.edges, [{ from: "PRD-9", to: "REQ-2", type: "requirement" }]);
  });

  it("ignores a related key whose value is not an array", () => {
    const g = buildGraph([
      {
        id: "PRD-8",
        kind: "PRD",
        title: "",
        status: "",
        path: "p.md",
        related: { requirement: "REQ-1" }, // string, not array
        virtual: false,
      },
    ]);
    assert.deepEqual(g.edges, []);
  });
});

describe("renderFlatTable", () => {
  it("renders a header, separator, and one row per node with '-' for empty lists", () => {
    const md = renderFlatTable([
      {
        id: "PRD-1",
        title: "Login",
        status: "Draft",
        path: "docs/prds/p.md",
        related: { requirement: ["REQ-1"] },
      },
    ]);
    const lines = md.split("\n");
    assert.match(lines[0], /^\| doc_id \|/);
    assert.match(lines[1], /^\|---\|/);
    assert.match(lines[2], /PRD-1/);
    assert.match(lines[2], /REQ-1/);
    assert.match(lines[2], /\| - \|/); // an empty related list becomes "-"
  });
});

describe("renderSummary", () => {
  it("counts primary docs by kind and edges by type", () => {
    const primary = [
      { id: "PRD-1", kind: "PRD", related: {} },
      { id: "SPEC-1", kind: "SPEC", related: {} },
    ];
    const graph = {
      nodes: [...primary, { id: "REQ-1", kind: "REQ", virtual: true }],
      edges: [{ from: "PRD-1", to: "REQ-1", type: "requirement" }],
    };
    const out = renderSummary(primary, graph);
    assert.match(out, /Primary docs: 2/);
    assert.match(out, /PRD: 1/);
    assert.match(out, /SPEC: 1/);
    assert.match(out, /Virtual targets .*: 1/);
    assert.match(out, /Total edges: 1/);
    assert.match(out, /`requirement`: 1/);
  });
});
