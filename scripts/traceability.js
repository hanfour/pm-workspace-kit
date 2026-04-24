#!/usr/bin/env node
/**
 * Traceability tool for PM/SA workflow.
 *
 * Modes:
 *   node scripts/traceability.js matrix
 *     Writes docs/traceability-matrix.md: flat table + Mermaid
 *     dependency graph + reverse-lookup (backlinks) + orphan / dangling
 *     report. One command, full picture.
 *
 *   node scripts/traceability.js check [file1 file2 ...]
 *     Validates required front-matter fields. Non-zero exit on failure.
 *     If no files are given, checks every tracked markdown.
 *
 * Required front-matter fields by doc type (doc_id prefix determines type):
 *   PRD-*    : doc_id, title, owner, status, date, related.requirement
 *   SPEC-*   : doc_id, title, owner, status, date, related.prd
 *   PLAN-*   : doc_id, title, owner, status, date
 *   HANDOFF-*: tracked in matrix but not validated (advisory type)
 *   ADR-*    : lives under docs/adr/; referenced but not scanned
 *
 * Graph model:
 *   - Primary nodes: docs with doc_id front-matter
 *   - Virtual nodes: every `related.*` target referenced by at least
 *     one primary node (ADR ids, module ids, architecture paths, ...)
 *   - Edges: from primary doc to each item in each related.<key> list
 *
 * Output is intentionally dependency-light: gray-matter only.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");

// ROOT defaults to the repo containing this script. Override with
// --cwd=<path> on the command line, useful for running the kit's
// scripts against a sub-repo like examples/acme-ads.
function resolveRoot(argv) {
  const flag = argv.find((a) => a.startsWith("--cwd="));
  if (flag) {
    const custom = flag.slice("--cwd=".length);
    return path.resolve(process.cwd(), custom);
  }
  return path.resolve(__dirname, "..");
}

const ROOT = resolveRoot(process.argv.slice(2));
const SCAN_DIRS = [
  "docs/prds",
  "docs/specs",
  "docs/plans",
  "docs/requirements",
  "docs/handoff",
  ".claude/plans",
];

const REQUIRED_FIELDS = {
  PRD: ["doc_id", "title", "owner", "status", "date", "related.requirement"],
  SPEC: ["doc_id", "title", "owner", "status", "date", "related.prd"],
  PLAN: ["doc_id", "title", "owner", "status", "date"],
};

// related.<key> are edge types. Order here drives graph color legend.
const EDGE_KEYS = [
  "requirement",
  "prd",
  "spec",
  "plan",
  "architecture",
  "adr",
  "module",
];

// ─── common helpers ──────────────────────────────────────────

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && p.endsWith(".md")) out.push(p);
  }
  return out;
}

function loadDoc(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  const rel = path.relative(ROOT, absPath);
  try {
    const parsed = matter(raw);
    return { path: rel, data: parsed.data, parseError: null };
  } catch (err) {
    return { path: rel, data: {}, parseError: err.message };
  }
}

function getDocType(docId) {
  if (!docId) return null;
  const prefix = String(docId).split("-")[0];
  return prefix;
}

function getNested(obj, dotPath) {
  return dotPath.split(".").reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

// ─── check mode ──────────────────────────────────────────────

function validateDoc(doc) {
  const errors = [];
  if (doc.parseError) {
    return {
      ok: false,
      skipped: false,
      errors: [`YAML parse error: ${doc.parseError.split("\n")[0]}`],
    };
  }
  if (!doc.data || Object.keys(doc.data).length === 0) {
    return { ok: true, skipped: true, errors };
  }
  const type = getDocType(doc.data.doc_id);
  if (!type || !REQUIRED_FIELDS[type]) {
    return { ok: true, skipped: true, errors };
  }
  for (const field of REQUIRED_FIELDS[type]) {
    const v = getNested(doc.data, field);
    if (v === undefined || v === null || v === "") {
      errors.push(`missing field: ${field}`);
    }
  }
  return { ok: errors.length === 0, skipped: false, errors, type };
}

function cmdCheck(argv) {
  const fileArgs = argv.filter((a) => !a.startsWith("--"));
  const targets =
    fileArgs.length > 0
      ? fileArgs.map((f) => path.resolve(ROOT, f))
      : SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

  let failed = 0;
  let checked = 0;
  for (const abs of targets) {
    if (!fs.existsSync(abs) || !abs.endsWith(".md")) continue;
    const doc = loadDoc(abs);
    const result = validateDoc(doc);
    if (result.skipped) continue;
    checked += 1;
    if (!result.ok) {
      failed += 1;
      console.error(`FAIL  ${doc.path}`);
      for (const e of result.errors) console.error(`      - ${e}`);
    }
  }
  console.error(`\nTraceability check: ${checked - failed}/${checked} passed`);
  if (failed > 0) process.exit(1);
}

// ─── graph build ─────────────────────────────────────────────

function collectPrimaryNodes() {
  const nodes = [];
  for (const dir of SCAN_DIRS) {
    for (const abs of walk(path.join(ROOT, dir))) {
      const doc = loadDoc(abs);
      if (!doc.data || !doc.data.doc_id) continue;
      nodes.push({
        id: String(doc.data.doc_id),
        kind: getDocType(doc.data.doc_id),
        title: doc.data.title || "",
        status: doc.data.status || "",
        path: doc.path,
        related: doc.data.related || {},
        virtual: false,
      });
    }
  }
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

function buildGraph(primaryNodes) {
  const nodeMap = new Map();
  for (const n of primaryNodes) nodeMap.set(n.id, n);

  const edges = [];
  for (const node of primaryNodes) {
    for (const key of EDGE_KEYS) {
      const refs = node.related[key];
      if (!Array.isArray(refs)) continue;
      for (const raw of refs) {
        if (raw == null || raw === "") continue;
        const target = String(raw).trim();
        if (!target) continue;
        if (!nodeMap.has(target)) {
          nodeMap.set(target, {
            id: target,
            kind: inferVirtualKind(key, target),
            title: "",
            status: "",
            path: null,
            related: {},
            virtual: true,
          });
        }
        edges.push({ from: node.id, to: target, type: key });
      }
    }
  }
  return { nodes: Array.from(nodeMap.values()), edges };
}

function inferVirtualKind(edgeKey, target) {
  // Heuristics for labelling virtual nodes:
  //  - If target looks like a doc_id (PRD-/SPEC-/...), use that type.
  //  - Otherwise use the edge key (module / architecture / adr / ...).
  const prefix = String(target).split(/[-\s]/)[0];
  if (["PRD", "SPEC", "PLAN", "ADR", "HANDOFF", "REQ"].includes(prefix)) {
    return prefix;
  }
  return edgeKey;
}

// ─── render helpers ──────────────────────────────────────────

function safeId(id) {
  // Mermaid ids: alphanumeric + underscore only.
  return String(id).replace(/[^A-Za-z0-9]/g, "_");
}

function mermaidLabel(node) {
  if (node.virtual) return escapeLabel(node.id);
  const pieces = [node.id];
  if (node.title) pieces.push(`<i>${escapeLabel(node.title)}</i>`);
  if (node.status) pieces.push(`[${escapeLabel(node.status)}]`);
  return pieces.join("<br/>");
}

function escapeLabel(s) {
  return String(s).replace(/"/g, "'").replace(/\[/g, "(").replace(/\]/g, ")");
}

function renderMermaid(graph) {
  const byKind = (n) => n.kind || "other";
  const classDefs = {
    PRD: "fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e",
    SPEC: "fill:#dcfce7,stroke:#16a34a,color:#14532d",
    PLAN: "fill:#f3e8ff,stroke:#9333ea,color:#581c87",
    HANDOFF: "fill:#f5f5f4,stroke:#78716c,color:#292524",
    REQ: "fill:#fef3c7,stroke:#d97706,color:#78350f",
    ADR: "fill:#ffedd5,stroke:#ea580c,color:#7c2d12",
    module: "fill:#fef9c3,stroke:#ca8a04,color:#713f12",
    architecture: "fill:#ccfbf1,stroke:#0d9488,color:#134e4a",
    requirement: "fill:#fef3c7,stroke:#d97706,color:#78350f",
    other: "fill:#e5e7eb,stroke:#6b7280,color:#111827",
  };

  const lines = [];
  lines.push("```mermaid");
  lines.push("graph LR");
  // Classes
  for (const [cls, style] of Object.entries(classDefs)) {
    lines.push(`  classDef ${cls} ${style}`);
  }
  // Nodes
  for (const node of graph.nodes) {
    const id = safeId(node.id);
    const label = mermaidLabel(node);
    const shape = node.virtual ? `([${label}])` : `[${label}]`;
    lines.push(`  ${id}${shape}:::${byKind(node)}`);
  }
  // Edges
  for (const edge of graph.edges) {
    lines.push(`  ${safeId(edge.from)} -->|${edge.type}| ${safeId(edge.to)}`);
  }
  lines.push("```");
  return lines.join("\n");
}

function renderBacklinks(graph) {
  // For each node, compute incoming edges grouped by edge type.
  const incoming = new Map();
  for (const n of graph.nodes) incoming.set(n.id, []);
  for (const e of graph.edges) {
    incoming.get(e.to).push({ from: e.from, type: e.type });
  }

  const lines = [];
  const sortedNodes = graph.nodes
    .filter((n) => (incoming.get(n.id) || []).length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));

  if (sortedNodes.length === 0) {
    return ["_(no incoming references in the tracked set)_"].join("\n");
  }
  for (const n of sortedNodes) {
    const refs = incoming.get(n.id);
    const kind = n.virtual ? ` (${n.kind})` : "";
    lines.push(`### ${n.id}${kind}`);
    lines.push("");
    if (!n.virtual && n.path) {
      lines.push(`  Path: \`${n.path}\`  `);
    }
    lines.push(`  Referenced by (${refs.length}):`);
    for (const r of refs.sort((a, b) => a.from.localeCompare(b.from))) {
      lines.push(`  - \`${r.type}\` ← **${r.from}**`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderOrphans(graph) {
  const incomingCount = new Map();
  const outgoingCount = new Map();
  for (const n of graph.nodes) {
    incomingCount.set(n.id, 0);
    outgoingCount.set(n.id, 0);
  }
  for (const e of graph.edges) {
    outgoingCount.set(e.from, outgoingCount.get(e.from) + 1);
    incomingCount.set(e.to, incomingCount.get(e.to) + 1);
  }

  const primary = graph.nodes.filter((n) => !n.virtual);
  const noOutgoing = primary
    .filter((n) => outgoingCount.get(n.id) === 0)
    .map((n) => n.id);
  const citedByPrimary = primary.filter((n) => incomingCount.get(n.id) > 0);

  const lines = [];
  lines.push(
    "**Docs with no outgoing references** — they do not point at any upstream source. OK for standalone notes; suspicious for PRD/Spec/Plan that should cite requirements or architecture.",
  );
  lines.push("");
  if (noOutgoing.length === 0) {
    lines.push("- _(none — every primary doc links somewhere)_");
  } else {
    for (const id of noOutgoing.sort()) {
      const doc = graph.nodes.find((n) => n.id === id);
      lines.push(`- **${id}** (${doc.kind}) — \`${doc.path}\``);
    }
  }
  lines.push("");
  lines.push(
    `**Primary-to-primary citations** — ${citedByPrimary.length} of ${primary.length} primary docs are cited by another primary doc via doc_id. If this number stays near zero, most references flow into virtual targets (ADRs, modules, architecture paths) rather than between primary docs; that is normal for this workspace but can be improved by having PRDs cite their parent plan / requirement by doc_id.`,
  );
  lines.push("");
  if (citedByPrimary.length > 0) {
    for (const n of citedByPrimary.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- ${n.id} ← cited ${incomingCount.get(n.id)}x`);
    }
  }
  return lines.join("\n");
}

function renderFlatTable(primaryNodes) {
  const fmt = (v) => (Array.isArray(v) && v.length ? v.join(", ") : "-");
  const lines = [];
  lines.push(
    "| doc_id | title | status | requirement | prd | spec | architecture | adr | module | path |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of primaryNodes) {
    const row = [
      r.id,
      r.title,
      r.status,
      fmt(r.related.requirement),
      fmt(r.related.prd),
      fmt(r.related.spec),
      fmt(r.related.architecture),
      fmt(r.related.adr),
      fmt(r.related.module),
      `\`${r.path}\``,
    ];
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

function renderSummary(primaryNodes, graph) {
  const byKind = primaryNodes.reduce((acc, n) => {
    acc[n.kind] = (acc[n.kind] || 0) + 1;
    return acc;
  }, {});
  const edgeByType = graph.edges.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});
  const lines = [];
  lines.push(`- Primary docs: ${primaryNodes.length}`);
  for (const [k, v] of Object.entries(byKind).sort()) {
    lines.push(`  - ${k}: ${v}`);
  }
  lines.push(
    `- Virtual targets (modules / adrs / archs referenced but not primary): ${graph.nodes.length - primaryNodes.length}`,
  );
  lines.push(`- Total edges: ${graph.edges.length}`);
  for (const [k, v] of Object.entries(edgeByType).sort()) {
    lines.push(`  - \`${k}\`: ${v}`);
  }
  return lines.join("\n");
}

// ─── matrix command (enhanced) ───────────────────────────────

function cmdMatrix() {
  const primaryNodes = collectPrimaryNodes();
  const graph = buildGraph(primaryNodes);

  const sections = [];
  sections.push("# Traceability Matrix");
  sections.push("");
  sections.push(
    "> Auto-generated by `scripts/traceability.js matrix`. Do not edit.",
  );
  sections.push(`> Last generated: ${new Date().toISOString().slice(0, 10)}`);
  sections.push("");
  sections.push("## 1. Summary");
  sections.push("");
  sections.push(renderSummary(primaryNodes, graph));
  sections.push("");
  sections.push("## 2. Documents by doc_id");
  sections.push("");
  sections.push(renderFlatTable(primaryNodes));
  sections.push("");
  sections.push("## 3. Dependency Graph");
  sections.push("");
  sections.push(
    "Rounded nodes are virtual (referenced ADRs / modules / architecture chapters that do not themselves have front-matter). Rectangular nodes are primary tracked docs.",
  );
  sections.push("");
  sections.push(renderMermaid(graph));
  sections.push("");
  sections.push("## 4. Reverse Lookup (backlinks)");
  sections.push("");
  sections.push(renderBacklinks(graph));
  sections.push("");
  sections.push("## 5. Orphans & Isolation");
  sections.push("");
  sections.push(renderOrphans(graph));
  sections.push("");

  const out = path.join(ROOT, "docs/traceability-matrix.md");
  fs.writeFileSync(out, sections.join("\n") + "\n");
  console.log(
    `Wrote ${path.relative(ROOT, out)} (${primaryNodes.length} primary, ${graph.nodes.length - primaryNodes.length} virtual, ${graph.edges.length} edges)`,
  );
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--cwd="));
  const [cmd, ...rest] = args;
  if (cmd === "check") return cmdCheck(rest);
  if (cmd === "matrix") return cmdMatrix();
  console.error("Usage:");
  console.error("  node scripts/traceability.js matrix [--cwd=<path>]");
  console.error(
    "  node scripts/traceability.js check [--cwd=<path>] [file...]",
  );
  console.error("");
  console.error(
    "  --cwd=<path>  Override the repo root. Defaults to the script's parent.",
  );
  console.error(
    "                Example: --cwd=examples/acme-ads to validate the bundled example.",
  );
  process.exit(2);
}

main();
