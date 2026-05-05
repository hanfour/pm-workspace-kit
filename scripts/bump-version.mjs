#!/usr/bin/env node
/**
 * Bump the workspace version across root + apps/* + packages/*
 * package.json files.
 *
 * Usage:
 *   node scripts/bump-version.mjs <semver>
 *
 * The release flow tags via git, but package.json#version had drifted
 * from the tag stream (root + 6 sub-packages stuck on 0.3.0 while tags
 * marched to v0.10.0). This script keeps them in sync.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const v = process.argv[2];
if (!v || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) {
  console.error("usage: node scripts/bump-version.mjs <semver>");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function workspacePackages(dir) {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .map((name) => join(full, name, "package.json"))
    .filter((p) => existsSync(p));
}

const files = [
  join(root, "package.json"),
  ...workspacePackages("packages"),
  ...workspacePackages("apps"),
];

for (const f of files) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  const prev = j.version;
  j.version = v;
  writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  console.log(`  ${f.replace(root + "/", "")}: ${prev} → ${v}`);
}

console.log(`\nbumped ${files.length} package.json files to ${v}`);
