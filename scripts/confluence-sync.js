#!/usr/bin/env node
/**
 * Confluence -> Git 雙向同步（中版）
 *
 * Pulls two kinds of updates from Confluence and writes them back to
 * the local markdown source:
 *   1. New comments (inline + footer) appended to the file's
 *      "## Confluence 意見彙總" section
 *   2. Status label changes (e.g. prd-approved) mapped to the
 *      front-matter `status` field
 *
 * Not handled (by design, to keep complexity bounded):
 *   - Page body edits made in Confluence. Stakeholders who need to
 *     edit content still go through Git PR.
 *   - Merge conflicts. Git is single source of truth for content.
 *
 * Modes:
 *   node scripts/confluence-sync.js sync              # pull + write
 *   node scripts/confluence-sync.js sync --dry-run    # report, no write
 *   node scripts/confluence-sync.js list              # list tracked files
 *
 * Env vars required for live API calls:
 *   CONFLUENCE_BASE_URL   e.g. https://guoshi.atlassian.net/wiki
 *   CONFLUENCE_EMAIL      atlassian account email
 *   CONFLUENCE_API_TOKEN  api token from id.atlassian.com/manage-profile/security/api-tokens
 *
 * State persisted to .confluence-sync-state.json (gitignored; tracks
 * last-seen comment id per page so re-runs do not duplicate).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, '.confluence-sync-state.json');

const SCAN_DIRS = [
  'docs/prds',
  'docs/specs',
  'docs/plans',
  'docs/requirements',
  '.claude/plans',
];

// Label -> status mapping. Labels are the Confluence-side source of
// truth for review state. If a page has multiple status labels the
// first match in this order wins.
const LABEL_TO_STATUS = [
  { label: 'status-approved', status: 'Approved' },
  { label: 'status-in-review', status: 'In Review' },
  { label: 'status-deprecated', status: 'Deprecated' },
  { label: 'status-draft', status: 'Draft' },
];

const COMMENTS_SECTION_HEADER = '## Confluence 意見彙總';

// ─── helpers ─────────────────────────────────────────────────

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && p.endsWith('.md')) out.push(p);
  }
  return out;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { pages: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function collectTrackedFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    for (const abs of walk(path.join(ROOT, dir))) {
      const raw = fs.readFileSync(abs, 'utf8');
      let parsed;
      try { parsed = matter(raw); } catch { continue; }
      const data = parsed.data || {};
      const pageId = data.related && data.related.confluence_page_id;
      if (!pageId) continue;
      files.push({
        path: path.relative(ROOT, abs),
        absPath: abs,
        raw,
        data,
        content: parsed.content,
        pageId: String(pageId),
      });
    }
  }
  return files;
}

// ─── Confluence API ──────────────────────────────────────────

function authHeader() {
  const { CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN } = process.env;
  if (!CONFLUENCE_EMAIL || !CONFLUENCE_API_TOKEN) {
    throw new Error('Missing CONFLUENCE_EMAIL / CONFLUENCE_API_TOKEN env vars');
  }
  const token = Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

async function apiGet(pathname) {
  const base = process.env.CONFLUENCE_BASE_URL;
  if (!base) throw new Error('Missing CONFLUENCE_BASE_URL env var');
  const url = `${base.replace(/\/$/, '')}${pathname}`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Confluence API ${res.status} ${res.statusText} for ${pathname}`);
  return res.json();
}

async function fetchLabels(pageId) {
  const data = await apiGet(`/api/v2/pages/${pageId}/labels`);
  return (data.results || []).map((l) => l.name);
}

async function fetchComments(pageId) {
  const [inline, footer] = await Promise.all([
    apiGet(`/api/v2/pages/${pageId}/inline-comments?limit=100&body-format=atlas_doc_format`).catch(() => ({ results: [] })),
    apiGet(`/api/v2/pages/${pageId}/footer-comments?limit=100&body-format=atlas_doc_format`).catch(() => ({ results: [] })),
  ]);
  const normalize = (c, kind) => ({
    id: String(c.id),
    kind,
    author: (c.version && c.version.authorId) || 'unknown',
    createdAt: (c.version && c.version.createdAt) || '',
    text: extractPlainText(c.body),
    resolved: !!(c.resolutionStatus && c.resolutionStatus === 'resolved'),
  });
  return [
    ...(inline.results || []).map((c) => normalize(c, 'inline')),
    ...(footer.results || []).map((c) => normalize(c, 'footer')),
  ];
}

function extractPlainText(body) {
  // Confluence atlas_doc_format is a ProseMirror JSON tree; walk it and
  // join text nodes. Good enough for appending to a markdown section.
  if (!body) return '';
  try {
    const doc = body.atlas_doc_format
      ? JSON.parse(body.atlas_doc_format.value)
      : body;
    const parts = [];
    const walk = (node) => {
      if (!node) return;
      if (node.type === 'text' && typeof node.text === 'string') parts.push(node.text);
      if (Array.isArray(node.content)) node.content.forEach(walk);
    };
    walk(doc);
    return parts.join('').trim();
  } catch {
    return '';
  }
}

// ─── write-back ──────────────────────────────────────────────

function statusFromLabels(labels) {
  for (const { label, status } of LABEL_TO_STATUS) {
    if (labels.includes(label)) return status;
  }
  return null;
}

function applyStatusChange(file, nextStatus) {
  if (!nextStatus) return { changed: false };
  if (file.data.status === nextStatus) return { changed: false };
  const previous = file.data.status;
  const newData = { ...file.data, status: nextStatus };
  const rebuilt = matter.stringify(file.content, newData);
  return { changed: true, previous, next: nextStatus, content: rebuilt };
}

function appendComments(fileContent, newComments) {
  if (!newComments.length) return { changed: false, content: fileContent };
  const lines = newComments.map((c) => {
    const header = `- **[${c.kind}]** _${c.createdAt || 'unknown time'}_ — author \`${c.author}\`${c.resolved ? ' *(resolved)*' : ''}`;
    const body = c.text ? `  \n  > ${c.text.replace(/\n/g, '\n  > ')}` : '';
    return header + body;
  }).join('\n\n');
  const block = `\n\n${COMMENTS_SECTION_HEADER}\n\n${lines}\n`;

  // If section exists, append under it; otherwise append a new section at EOF.
  if (fileContent.includes(COMMENTS_SECTION_HEADER)) {
    // Insert the new lines right after the section header, preserving existing items.
    const updated = fileContent.replace(
      new RegExp(`^${COMMENTS_SECTION_HEADER}\\s*`, 'm'),
      (match) => `${match}\n${lines}\n\n`,
    );
    return { changed: true, content: updated };
  }
  return { changed: true, content: fileContent.replace(/\s*$/, '') + block };
}

// ─── main ─────────────────────────────────────────────────────

async function cmdSync({ dryRun }) {
  const files = collectTrackedFiles();
  if (files.length === 0) {
    console.log('No tracked files with confluence_page_id found.');
    return;
  }
  const state = loadState();
  const summary = { files: 0, statusUpdates: 0, newComments: 0, pages: [] };

  for (const file of files) {
    const pageState = state.pages[file.pageId] || { seenCommentIds: [] };
    const pageReport = { path: file.path, pageId: file.pageId, statusChange: null, newCommentCount: 0 };

    let labels, comments;
    try {
      [labels, comments] = await Promise.all([
        fetchLabels(file.pageId),
        fetchComments(file.pageId),
      ]);
    } catch (err) {
      pageReport.error = err.message;
      summary.pages.push(pageReport);
      continue;
    }

    // Comments: diff against state.
    const seen = new Set(pageState.seenCommentIds);
    const newOnes = comments.filter((c) => !seen.has(c.id));

    // Status: recompute from labels.
    const nextStatus = statusFromLabels(labels);

    // Build new file content.
    let nextContent = file.raw;
    let statusResult = { changed: false };
    if (nextStatus) {
      statusResult = applyStatusChange({ ...file, raw: nextContent }, nextStatus);
      if (statusResult.changed) {
        nextContent = statusResult.content;
        pageReport.statusChange = { from: statusResult.previous, to: statusResult.next };
      }
    }
    const commentResult = appendComments(nextContent, newOnes);
    if (commentResult.changed) {
      nextContent = commentResult.content;
      pageReport.newCommentCount = newOnes.length;
    }

    if (!dryRun && (statusResult.changed || commentResult.changed)) {
      fs.writeFileSync(file.absPath, nextContent);
    }

    // Update state regardless (so re-runs skip known comments next time).
    if (!dryRun) {
      state.pages[file.pageId] = {
        seenCommentIds: comments.map((c) => c.id),
        lastSyncedAt: new Date().toISOString(),
      };
    }

    summary.files += 1;
    if (statusResult.changed) summary.statusUpdates += 1;
    summary.newComments += newOnes.length;
    summary.pages.push(pageReport);
  }

  if (!dryRun) saveState(state);

  // Report
  console.log(`Confluence sync ${dryRun ? '(dry-run) ' : ''}complete.`);
  console.log(`  Files scanned:  ${summary.files}`);
  console.log(`  Status updates: ${summary.statusUpdates}`);
  console.log(`  New comments:   ${summary.newComments}`);
  for (const p of summary.pages) {
    const bits = [];
    if (p.error) bits.push(`ERROR: ${p.error}`);
    if (p.statusChange) bits.push(`status ${p.statusChange.from || '—'} -> ${p.statusChange.to}`);
    if (p.newCommentCount > 0) bits.push(`+${p.newCommentCount} comments`);
    if (bits.length) console.log(`  - ${p.path}: ${bits.join('; ')}`);
  }
}

function cmdList() {
  const files = collectTrackedFiles();
  if (!files.length) { console.log('(none)'); return; }
  for (const f of files) console.log(`${f.pageId}\t${f.data.status || '-'}\t${f.path}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes('--dry-run');
  if (cmd === 'sync') return cmdSync({ dryRun });
  if (cmd === 'list') return cmdList();
  console.error('Usage:');
  console.error('  node scripts/confluence-sync.js sync [--dry-run]');
  console.error('  node scripts/confluence-sync.js list');
  process.exit(2);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
