import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Extract the section between `=== PRD ===` and `=== END ===` markers.
 * Falls back to the full text if markers are absent.
 */
export function extractPrdBody(fullText: string): string {
  const startIdx = fullText.indexOf("=== PRD ===");
  const endIdx = fullText.indexOf("=== END ===");
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return fullText.trim();
  }
  return fullText.slice(startIdx + "=== PRD ===".length, endIdx).trim();
}

/**
 * Derive the next sequential PRD id for the given directory and year.
 */
export function nextPrdId(dir: string, year = new Date().getFullYear()): string {
  if (!fs.existsSync(dir)) return `PRD-${year}-0001`;
  const prefix = `PRD-${year}-`;
  let maxN = 0;
  for (const f of fs.readdirSync(dir)) {
    const content = fs.readFileSync(path.join(dir, f), "utf8");
    const m = content.match(new RegExp(`doc_id:\\s*${prefix}(\\d+)`));
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `${prefix}${String(maxN + 1).padStart(4, "0")}`;
}

/**
 * Slugify a title for the filename.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 60);
}

/**
 * Write a PRD markdown file, using the current date and a slug from the title.
 * Returns the full absolute path of the written file.
 */
export function writePrd(body: string, title: string, docsDir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const slug = slugify(title) || "untitled";
  const filename = `${today}-${slug}-prd.md`;
  const fullPath = path.join(docsDir, filename);
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(fullPath, body.endsWith("\n") ? body : body + "\n");
  return fullPath;
}
