# Run the live gateway from a release directory, not the working tree

**Date:** 2026-09-21
**Status:** Approved, pending implementation
**Touches:** new `packages/cli/src/gateway/deploy/`, new `packages/cli/src/commands/gateway/deploy.ts`,
`packages/cli/src/commands/gateway/service.ts`, `commands/gateway/index.ts`, status output, one new doctor check

## Problem

The LaunchAgent `com.pmk.gateway` runs
`/Users/<user>/pm-workspace-kit/packages/cli/dist/index.js` — the working tree's build output.
`install-service` derives that path from `path.resolve(__dirname, "../../index.js")`, so
whichever `dist` ran the installer becomes production.

Consequences:

- `npm run cli:build` starts with `rm -rf dist`. Running it in the repo deletes the directory
  the live process was loaded from. With `KeepAlive`, the next restart runs whatever the build
  left behind, verified or not.
- Production depends on four build outputs, not one: `@pmk/shared`, `@pmk/rag` and `@pmk/llm`
  resolve through `node_modules/@pmk/*` symlinks back into the repo. Building any of them
  changes production.
- Nothing records which commit is live. Today it is inferred from `dist` mtime vs. tag time.

The only guard is remembering not to build in this checkout.

## Decisions

1. **Releases are built from a git commit**, never copied from the working tree. Any ref is
   accepted (SHA, branch, tag) because the release workflow verifies live in Slack *before*
   tagging, so production must be able to run an untagged commit.
2. **One command deploys end to end, with automatic rollback.** `--no-activate` builds without
   switching.
3. **Switching is a symlink flip.** The plist never changes after the one-time migration.

## Layout

```
~/.pmk/releases/
  0.44.0-2fa1497/        full `git archive` export + node_modules + the four dists
  0.45.0-abc1234/
  current  -> 0.45.0-abc1234
  previous -> 0.44.0-2fa1497
  .staging-<sha>/        exists only during a build
```

Release name: `<package.json version>-<7-char sha>`.

Each release holds `RELEASE.json`: `{ ref, sha, version, builtAt, nodeVersion }`.

The plist entry point is fixed at `~/.pmk/releases/current/packages/cli/dist/index.js`. Node
resolves the main module to its real path at startup, so flipping `current` does not affect a
running process; it takes effect on the next start. Inside a release, `node_modules/@pmk/*`
symlinks point within that release — the directory has no dependency on the repo.

## Commands

| Command | Behaviour |
|---|---|
| `pmk gateway deploy <ref> [--repo <path>] [--no-activate]` | build, smoke-test, activate, verify, roll back on failure |
| `pmk gateway activate <release>` | activate an already-built release |
| `pmk gateway rollback` | activate `previous` |
| `pmk gateway status` | adds one line: the current release and its sha |
| `pmk gateway doctor` | new check: warn when the plist entry point is inside a git working tree |

`--repo` defaults to the git toplevel of `process.cwd()`.

## Deploy sequence

1. **Resolve.** Validate the ref string (same character rules as `assertSafeBranch`), then
   `git rev-parse --verify <ref>^{commit}`. Every external command goes through `execFile`; no
   shell. Read the version with `git show <sha>:package.json` to form the release name; if
   that release directory already exists, skip to step 6.
2. **Export.** `git archive <sha>` into `~/.pmk/releases/.staging-<sha>/`. Tracked files only —
   uncommitted edits and `.env` files cannot leak in. Staging sits on the same filesystem as
   its final location so the later rename is a single operation.
3. **Build.** `npm ci` scoped to the `cli`, `llm`, `rag`, `shared` workspaces, then build in
   CI's order: shared → rag → llm → cli.
4. **Smoke test.** `node <staging>/packages/cli/dist/index.js --version` must equal the
   exported `package.json` version; `gateway status` must exit 0 (loads config and the main
   module graph, read-only). `gateway doctor` is deliberately not used: its result depends on
   the network at that moment, not on the build.
5. **Promote.** Write `RELEASE.json`, rename staging to the release name. Any failure in steps
   2–5 deletes staging and exits non-zero. `current` is untouched.
6. **Activate.** Point `previous` at the old `current`, then point `current` at the new
   release (create a temp symlink, `rename` over the old one — no intermediate state). Restart
   through the existing restart path. Under launchd that path only issues `kickstart -k` and
   returns; it does not wait. Activation therefore records the pid before restarting and polls
   `runtime.json` itself for a *different* pid with `phase: "ready"`.
   If the installed LaunchAgent does not run `releases/current` (the pre-migration state), the
   links are flipped but the service is not restarted — restarting would relaunch the old tree
   and report a false success. The command says so and prints the `install-service` step.
7. **Verify or roll back.** No `ready` within 60 s → point `current` and `previous` back,
   restart again, report the failure and exit non-zero.
8. **Prune.** Keep `current`, `previous`, and at most 3 releases total.
9. **Record.** Append `gateway.deployed` (or `gateway.rollback`) to the events log with
   `{ release, sha, ref, previous }`.

A restart interrupts in-flight work. The gateway drains for 25 s; an mra review runs for
minutes and will be cut off (its claim self-releases; the requester re-triggers). Accepted —
`--no-activate` plus `activate` exists for choosing the moment.

## install-service

`distEntry` resolution changes:

- running from under `~/.pmk/releases/` → write the `current/...` path, not the versioned one
- running from inside a git working tree → print a warning, proceed as before

## Files

New, each under 200 lines:

- `gateway/deploy/paths.ts` — releases root, release naming, `current`/`previous` resolution, `RELEASE.json` I/O
- `gateway/deploy/build.ts` — resolve, export, build, smoke test, promote
- `gateway/deploy/activate.ts` — symlink flip, restart, verify, rollback
- `gateway/deploy/prune.ts` — retention
- `commands/gateway/deploy.ts` — argument parsing and output for `deploy` / `activate` / `rollback`
- `gateway/doctor-checks/release-entry.ts`

Modified: `commands/gateway/service.ts`, `commands/gateway/index.ts`, the status block in
`commands/gateway/ops.ts`, the events type list. `gateway/config.ts` is not touched.

## Testing

Unit tests inject `execFile` and the filesystem root, following the `RestartDeps` pattern, and
run under a temp HOME that is never restored. Cases:

- ref validation rejects flag-like and shell-special input
- a failed build or smoke test leaves `current` and `previous` unchanged and removes staging
- the symlink flip sets `previous` correctly, including the first-ever deploy (no `current` yet)
- `ready` timeout triggers rollback and a second restart
- prune never removes `current` or `previous`
- `install-service` path resolution for the three locations (release dir, working tree, other)

A test that really runs `npm ci` is too slow for the suite. Instead: one real deploy on the
production machine, then the usual live Slack verification before tagging.

## One-time migration

The first deploy cannot be preceded by a repo build (that would delete the live `dist`), so it
runs from source:

```
npx tsx packages/cli/src/index.ts gateway deploy HEAD      # builds, flips links, does not restart
node ~/.pmk/releases/current/packages/cli/dist/index.js gateway install-service --force
launchctl bootout   gui/$UID/com.pmk.gateway
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.pmk.gateway.plist
```

`kickstart -k` restarts the loaded job definition, which still names the old entry point, so
the agent has to be unloaded and loaded again. Done by hand, once, with the operator watching;
the plan's last task has the verification and the fallback.

## Measured (2026-09-21, spike on the production machine)

`git archive HEAD` → `npm ci -w packages/cli -w packages/llm -w packages/rag -w packages/shared`
→ build in CI order, in a scratch directory:

- install 56 s, build 49 s
- 310 MB per release (export itself 5.5 MB); no electron, no docusaurus
- `node_modules/@pmk/*` are relative symlinks inside the export
- `node packages/cli/dist/index.js --version` printed `0.44.0`

Scoped install works; the full-install fallback is not needed. Retention of 3 ≈ 930 MB.

## Out of scope

- The `pmk` binary on PATH is an `npm link` into the repo's `dist`. A repo build briefly breaks
  the `pmk` command; it no longer affects the service.
- Waiting for in-flight reviews before restarting.
- Log rotation, secret references, the exemption subcommand.
