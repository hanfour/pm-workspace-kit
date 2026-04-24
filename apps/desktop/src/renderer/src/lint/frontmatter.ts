import matter from "gray-matter";

export interface Diagnostic {
  line: number;
  message: string;
}

const REQUIRED_PRD = ["doc_id", "title", "status", "date"] as const;

/**
 * Lint front-matter in a Markdown document.
 * Cheap pass — reports missing required fields and bad YAML.
 */
export function lintFrontMatter(body: string): Diagnostic[] {
  if (!body.startsWith("---")) return [];
  const diags: Diagnostic[] = [];
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(body);
  } catch (err) {
    diags.push({ line: 1, message: `YAML parse: ${(err as Error).message}` });
    return diags;
  }

  const data = parsed.data as Record<string, unknown>;
  const isPrd =
    typeof data.doc_id === "string" && data.doc_id.startsWith("PRD-");
  if (isPrd) {
    for (const key of REQUIRED_PRD) {
      if (data[key] === undefined || data[key] === "") {
        diags.push({ line: 2, message: `PRD front-matter missing "${key}"` });
      }
    }
    if (
      typeof data.doc_id === "string" &&
      !/^PRD-\d{4}-\d{4}$/.test(data.doc_id)
    ) {
      diags.push({
        line: 2,
        message: `doc_id "${data.doc_id}" does not match PRD-YYYY-NNNN`,
      });
    }
  }
  return diags;
}
