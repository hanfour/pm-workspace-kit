import * as fs from "node:fs";
import chalk from "chalk";
import { println } from "../../io";
import {
  approveAtom,
  findAtomByPrefix,
  loadAtoms,
  rejectAtom,
  searchAtoms,
} from "../../gateway/knowledge";
import type { KnowledgeAtom } from "../../gateway/knowledge";
import { loadTelemetry, type AtomTelemetryStore } from "../../gateway/atom-telemetry";
import {
  approvedAtomCount,
  ATOM_RANKED_THRESHOLD,
  buildAtomsIndex,
} from "../../gateway/atom-index";
import { spawnSync } from "node:child_process";

export interface AtomTelemetryRow {
  id: string;
  question: string;
  scope: string;
  createdAt: number;
  reuseCount: number;
  lastRetrievedAt: string | null;
  questionedCount: number;
  lastQuestionedAt: string | null;
  deadWeight: boolean;
  loadBearing: boolean;
}

const LOAD_BEARING_MIN_REUSE = 5;

export function buildAtomTelemetryReport(
  atoms: KnowledgeAtom[],
  store: AtomTelemetryStore,
): AtomTelemetryRow[] {
  const rows = atoms.map((a) => {
    const t = store.atoms[a.id];
    const reuseCount = t?.reuseCount ?? 0;
    const questionedCount = t?.questionedCount ?? 0;
    return {
      id: a.id,
      question: a.question,
      scope: a.scope,
      createdAt: a.createdAt,
      reuseCount,
      lastRetrievedAt: t?.lastRetrievedAt ?? null,
      questionedCount,
      lastQuestionedAt: t?.lastQuestionedAt ?? null,
      deadWeight: reuseCount === 0,
      loadBearing: reuseCount >= LOAD_BEARING_MIN_REUSE && questionedCount === 0,
    };
  });
  // Weakest first: lowest reuse, then oldest lastRetrievedAt.
  return rows.sort(
    (x, y) =>
      x.reuseCount - y.reuseCount ||
      (x.lastRetrievedAt ?? "").localeCompare(y.lastRetrievedAt ?? ""),
  );
}

function atomsUsage(): void {
  println(
    chalk.yellow(
      "usage:\n" +
        "  pmk gateway atoms list [--all|--pending|--approved] [--scope <name>]\n" +
        "  pmk gateway atoms show <id-or-prefix>\n" +
        "  pmk gateway atoms search <query> [--scope <name>] [--limit N]\n" +
        "  pmk gateway atoms edit <id-or-prefix>\n" +
        "  pmk gateway atoms approve <id-or-prefix>\n" +
        "  pmk gateway atoms reject <id-or-prefix>\n" +
        "  pmk gateway atoms reindex [--scope <name>]\n" +
        "  pmk gateway atoms telemetry [--json]",
    ),
  );
}

function formatAtomRow(atom: {
  id: string;
  scope: string;
  question: string;
  status?: string;
  expiresAt?: number;
}): string {
  const statusTag =
    atom.status === "pending"
      ? chalk.yellow("pending ")
      : chalk.green("approved");
  const idShort = atom.id
    .split("-")
    .slice(0, 2)
    .join("-")
    .padEnd(20)
    .slice(0, 20);
  const ttl = atom.expiresAt
    ? ` (TTL ${Math.max(0, Math.floor((atom.expiresAt - Date.now()) / 60_000))}m)`
    : "";
  const q = atom.question.slice(0, 70);
  return `  ${statusTag}  ${idShort}  ${atom.scope.padEnd(10).slice(0, 10)}  ${q}${ttl}`;
}

export function atomsCmd(rest: string[]): void {
  const [action, ...args] = rest;
  switch (action) {
    case undefined:
    case "list": {
      const filter = args.includes("--pending")
        ? "pending"
        : args.includes("--approved")
          ? "approved"
          : "all";
      const scopeIdx = args.indexOf("--scope");
      const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
      const atoms = loadAtoms({ scope }).filter((a) =>
        filter === "all" ? true : a.status === filter,
      );
      println(chalk.bold(`\npmk gateway atoms (${filter})`));
      if (atoms.length === 0) {
        println(chalk.dim("  (none)"));
        return;
      }
      println(
        chalk.dim("  status    id-prefix             scope       question"),
      );
      for (const a of atoms) println(formatAtomRow(a));
      return;
    }
    case "show": {
      const [idOrPrefix] = args;
      if (!idOrPrefix) {
        atomsUsage();
        process.exit(1);
      }
      const found = findAtomByPrefix(idOrPrefix);
      if (!found) {
        println(
          chalk.red(
            `no unique match for '${idOrPrefix}'. Try a longer prefix.`,
          ),
        );
        process.exit(1);
      }
      println(chalk.bold(`\n${found.atom.question}`));
      println(chalk.dim(`  id:       ${found.atom.id}`));
      println(chalk.dim(`  scope:    ${found.atom.scope}`));
      println(chalk.dim(`  status:   ${found.atom.status}`));
      if (found.atom.expiresAt) {
        const minsLeft = Math.max(
          0,
          Math.floor((found.atom.expiresAt - Date.now()) / 60_000),
        );
        println(chalk.dim(`  expires:  in ${minsLeft}m`));
      }
      println(
        chalk.dim(
          `  source:   ${found.atom.source.threadKey} via <@${found.atom.source.contributorUserId}>`,
        ),
      );
      println(chalk.dim(`  tags:     ${found.atom.tags.join(", ") || "—"}`));
      println(chalk.dim(`  file:     ${found.file}`));
      println("");
      if (found.atom.summary) {
        println(chalk.bold("Summary"));
        println(found.atom.summary);
        println("");
      }
      println(chalk.bold("Answer"));
      println(found.atom.answer);
      return;
    }
    case "search": {
      // pmk gateway atoms search <query> [--scope <name>] [--limit N]
      // Wraps searchAtoms() so the host can dry-run retrieval ranking
      // without sending a real Slack message — useful after adding a
      // new atom to verify "would this be retrieved when someone asks
      // X?" without DM-ing the bot.
      const scopeIdx = args.indexOf("--scope");
      const limitIdx = args.indexOf("--limit");
      const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
      const limitArg =
        limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1], 10) : NaN;
      const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 5;
      // Reconstruct the query from positional args (everything not a flag).
      const queryParts: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--scope" || args[i] === "--limit") {
          i++; // skip the value too
          continue;
        }
        queryParts.push(args[i]);
      }
      const query = queryParts.join(" ").trim();
      if (!query) {
        atomsUsage();
        process.exit(1);
      }
      const hits = searchAtoms(query, { scope, limit });
      println(
        chalk.bold(
          `\nsearch results for ${JSON.stringify(query)}${scope ? ` in scope ${scope}` : ""} (top ${limit})`,
        ),
      );
      if (hits.length === 0) {
        println(
          chalk.dim(
            "  (no approved atoms matched — pending atoms are excluded by design)",
          ),
        );
        return;
      }
      println(
        chalk.dim(
          "  rank  id-prefix             scope       tags                              question",
        ),
      );
      hits.forEach((atom, i) => {
        const idShort = atom.id
          .split("-")
          .slice(0, 2)
          .join("-")
          .padEnd(20)
          .slice(0, 20);
        const tags = atom.tags.slice(0, 3).join(", ").padEnd(32).slice(0, 32);
        const q = atom.question.slice(0, 60);
        println(
          `  ${String(i + 1).padStart(4)}  ${idShort}  ${atom.scope.padEnd(10).slice(0, 10)}  ${tags}  ${q}`,
        );
      });
      return;
    }
    case "edit": {
      // pmk gateway atoms edit <id-or-prefix> — open the .md file in
      // $EDITOR (fallback `vi`), validate post-save, atomic replace.
      const [idOrPrefix] = args;
      if (!idOrPrefix) {
        atomsUsage();
        process.exit(1);
      }
      const found = findAtomByPrefix(idOrPrefix);
      if (!found) {
        println(
          chalk.red(
            `no unique match for '${idOrPrefix}'. Try a longer prefix.`,
          ),
        );
        process.exit(1);
      }
      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      // Backup the original so we can restore on failure.
      const originalContent = fs.readFileSync(found.file, "utf8");
      const backupPath = `${found.file}.editbak`;
      fs.writeFileSync(backupPath, originalContent, "utf8");

      println(
        chalk.dim(
          `opening ${found.file} in ${editor}\n  (post-save: validate front-matter; required fields must keep id/createdAt/question/source)`,
        ),
      );
      const editResult = spawnSync(editor, [found.file], { stdio: "inherit" });
      if (editResult.status !== 0) {
        // User aborted ($EDITOR exited non-zero) — leave file alone.
        fs.unlinkSync(backupPath);
        println(chalk.dim("(editor exited non-zero; no changes made)"));
        return;
      }

      // Re-parse via findAtomByPrefix to validate the post-edit file.
      const reparsed = findAtomByPrefix(found.atom.id);
      if (!reparsed) {
        // Required fields broken; restore.
        fs.writeFileSync(found.file, originalContent, "utf8");
        fs.unlinkSync(backupPath);
        println(
          chalk.red(
            "post-edit validation failed (front-matter unparseable or missing required fields). Restored original.",
          ),
        );
        process.exit(1);
      }
      // Tag/contributor changes are fine; identity must hold.
      if (
        reparsed.atom.id !== found.atom.id ||
        reparsed.atom.createdAt !== found.atom.createdAt
      ) {
        fs.writeFileSync(found.file, originalContent, "utf8");
        fs.unlinkSync(backupPath);
        println(
          chalk.red(
            "post-edit validation failed (id or createdAt changed). Restored original.",
          ),
        );
        process.exit(1);
      }

      fs.unlinkSync(backupPath);
      println(chalk.green(`edited: ${reparsed.atom.id}`));
      return;
    }
    case "approve": {
      const [idOrPrefix] = args;
      if (!idOrPrefix) {
        atomsUsage();
        process.exit(1);
      }
      const atom = approveAtom(idOrPrefix);
      if (!atom) {
        println(
          chalk.red(
            `no unique match for '${idOrPrefix}'. Try a longer prefix.`,
          ),
        );
        process.exit(1);
      }
      println(chalk.green(`approved: ${atom.id}`));
      return;
    }
    case "reject": {
      const [idOrPrefix] = args;
      if (!idOrPrefix) {
        atomsUsage();
        process.exit(1);
      }
      const ok = rejectAtom(idOrPrefix);
      if (!ok) {
        println(
          chalk.red(
            `no unique match for '${idOrPrefix}'. Try a longer prefix.`,
          ),
        );
        process.exit(1);
      }
      println(chalk.green(`rejected (file deleted): ${idOrPrefix}`));
      return;
    }
    case "reindex": {
      // pmk gateway atoms reindex [--scope <name>]
      // Force-rebuild the BM25 index. Auto-rebuild on staleness
      // already happens at search-time, so this is mostly for
      // operators who want to confirm the index is up-to-date or
      // who tweaked PMK_ATOM_VECTOR_THRESHOLD and want to see what
      // would be ranked.
      const scopeIdx = args.indexOf("--scope");
      const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
      const before = approvedAtomCount(scope);
      println(
        chalk.dim(
          `building BM25 index over ${before} approved atoms${scope ? ` in scope ${scope}` : ""}…`,
        ),
      );
      const idx = buildAtomsIndex({ scope });
      println(
        chalk.green(
          `indexed ${idx.chunks.length} chunk(s); ranking threshold = ${ATOM_RANKED_THRESHOLD} ` +
            `(${before >= ATOM_RANKED_THRESHOLD ? "BM25 active" : "still using keyword scoring"})`,
        ),
      );
      return;
    }
    case "telemetry": {
      const json = args.includes("--json");
      const scopeIdx = args.indexOf("--scope");
      const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
      const atoms = loadAtoms({ scope }).filter(
        (a) => a.status === "approved" || a.status === undefined,
      );
      const rows = buildAtomTelemetryReport(atoms, loadTelemetry());
      if (json) {
        println(JSON.stringify(rows, null, 2));
        return;
      }
      println(chalk.bold("\npmk gateway atoms telemetry"));
      if (rows.length === 0) {
        println(chalk.dim("  (no approved atoms)"));
        return;
      }
      println(chalk.dim("  reuse  questioned   age  id-prefix             question"));
      for (const r of rows) {
        const flag = r.deadWeight
          ? chalk.yellow(" dead")
          : r.loadBearing
            ? chalk.green(" load")
            : "     ";
        const ageDays = Math.floor((Date.now() - r.createdAt) / 86_400_000);
        const age = `${ageDays}d`;
        println(
          `  ${String(r.reuseCount).padStart(5)}  ${String(r.questionedCount).padStart(10)}  ${age.padStart(4)} ${flag} ${r.id.slice(0, 20).padEnd(20)} ${r.question.slice(0, 50)}`,
        );
      }
      return;
    }
    default:
      atomsUsage();
      process.exit(1);
  }
}
