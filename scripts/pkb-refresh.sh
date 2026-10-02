#!/usr/bin/env bash
# Build/refresh mra PKB for ACTIVE OneAD repos so the Slack gateway's code
# reviews come out COMPLETE. The review agents lean on PKB instead of
# full-codebase grep; without a PKB they hit --max-turns and mra honestly
# reports REVIEW_INCOMPLETE. prepareReviewClone copies each repo's
# .mra/pkb into the review checkout, so a fresh + valid PKB per active repo is
# all the gateway needs.
#
# Idempotent: skips repos whose PKB is fresh + valid; (re)builds when the PKB is
# missing, stale (source newer than PKB), or error-polluted (a pre-fix build that
# saved an "Error: Reached max turns" string as a doc).
#
# Run on-demand:   bash scripts/pkb-refresh.sh [--dry-run]
# Run via cron/launchd for (c) — see scripts/pkb-refresh.plist.
#
# Env: MRA_WORKSPACE (default ~/OneAD), MRA_BIN (default ~/multi-repo-agent/bin/mra.sh),
#      PKB_REFRESH_ACTIVE_DAYS (default 30), PKB_REFRESH_CONCURRENCY (default 1),
#      PKB_REFRESH_GH_USER (optional gh identity for fetch-token lookup).
set -uo pipefail

WORKSPACE="${MRA_WORKSPACE:-$HOME/OneAD}"
MRA="${MRA_BIN:-$HOME/multi-repo-agent/bin/mra.sh}"
MAX_AGE_DAYS="${PKB_REFRESH_ACTIVE_DAYS:-30}"
# 1 by default: each `mra analyze` already runs 4 core agents in parallel, so
# 2 repos = 8 concurrent claude calls, which can trip API rate limits and make
# generators cut off. Raise via env only if your limits are comfortable.
CONCURRENCY="${PKB_REFRESH_CONCURRENCY:-1}"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

[[ -x "$MRA" || -f "$MRA" ]] || { echo "pkb-refresh: mra not found at $MRA" >&2; exit 1; }

# Keep the token in this shell only; pass it to git as an HTTP extraheader and
# to mra analyze as MRA_GIT_FETCH_TOKEN.
FETCH_TOKEN="${MRA_GIT_FETCH_TOKEN:-}"
if [[ -z "$FETCH_TOKEN" && -n "${PKB_REFRESH_GH_USER:-}" ]]; then
  if token_from_gh=$(gh auth token --user "$PKB_REFRESH_GH_USER" 2>/dev/null) && [[ -n "$token_from_gh" ]]; then
    FETCH_TOKEN="$token_from_gh"
  else
    echo "[warn] could not get a GitHub fetch token; continuing without one" >&2
  fi
fi
unset MRA_GIT_FETCH_TOKEN

github_https_url() {
  local url="$1" repo
  case "$url" in
    git@github.com:*)
      repo="${url#git@github.com:}"
      repo="${repo%.git}"
      [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
      printf 'https://github.com/%s.git' "$repo"
      ;;
    ssh://git@github.com/*)
      repo="${url#ssh://git@github.com/}"
      repo="${repo%.git}"
      [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
      printf 'https://github.com/%s.git' "$repo"
      ;;
    https://github.com/*)
      [[ "$url" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?/?$ ]] || return 1
      printf '%s' "$url"
      ;;
    *) return 1 ;;
  esac
}

remote_commit() {
  local dir="$1" url="$2" branch="$3" listing auth
  if [[ -n "$FETCH_TOKEN" ]]; then
    auth=$(printf 'x-access-token:%s' "$FETCH_TOKEN" | base64 | tr -d '\n')
    listing=$(GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0='http.https://github.com/.extraheader' \
      GIT_CONFIG_VALUE_0="Authorization: Basic $auth" \
      perl -e 'alarm shift; exec @ARGV' 15 git -C "$dir" ls-remote --exit-code --heads "$url" "refs/heads/$branch" 2>/dev/null) || return 1
  else
    listing=$(perl -e 'alarm shift; exec @ARGV' 15 git -C "$dir" ls-remote --exit-code --heads "$url" "refs/heads/$branch" 2>/dev/null) || return 1
  fi
  [[ -n "$listing" ]] || return 1
  printf '%s\n' "${listing%%[[:space:]]*}"
}

# Reason this repo needs a (re)build, or empty if it is fresh + valid.
build_reason() {
  local dir="$1"
  local pkb="$dir/.mra/pkb"
  [[ -f "$pkb/meta.json" ]] || { echo "missing"; return; }
  local d f
  for d in conventions architecture sitemap api-surface; do
    f="$pkb/$d.md"
    if [[ -f "$f" ]] && head -c 60 "$f" | grep -qiE "Error:|Reached max turns"; then
      echo "error-polluted ($d)"; return
    fi
  done
  local source_ref source_sha branch origin_url remote_url remote_sha local_note=""
  source_ref=$(jq -r '.sourceRef // empty' "$pkb/meta.json" 2>/dev/null || true)
  source_sha=$(jq -r '.sourceSha // empty' "$pkb/meta.json" 2>/dev/null || true)
  if [[ "$source_ref" == origin/* && -n "$source_sha" ]]; then
    branch="${source_ref#origin/}"
    origin_url=$(git -C "$dir" remote get-url origin 2>/dev/null || true)
    if [[ -n "$branch" ]] && remote_url=$(github_https_url "$origin_url"); then
      if remote_sha=$(remote_commit "$dir" "$remote_url" "$branch"); then
        if [[ "$remote_sha" != "$source_sha" ]]; then
          echo "stale ($source_ref moved)"; return
        fi
        echo ""; return
      fi
      local_note="$source_ref ls-remote failed"
    else
      local_note="$source_ref remote check skipped for unsupported origin"
    fi
  fi
  local pkb_mtime src_mtime
  pkb_mtime=$(stat -f %m "$pkb/meta.json" 2>/dev/null || stat -c %Y "$pkb/meta.json" 2>/dev/null || echo 0)
  src_mtime=$(git -C "$dir" log -1 --format=%ct 2>/dev/null || echo 0)
  if [[ "$src_mtime" -gt "$pkb_mtime" ]]; then
    if [[ -n "$local_note" ]]; then echo "stale ($local_note; local commit newer)"; else echo "stale"; fi
    return
  fi
  if [[ -n "$local_note" ]]; then echo "fresh ($local_note; local commit rule)"; else echo ""; fi
}

# Special repos to never auto-analyze (token/auth or sync-excluded; override via env).
EXCLUDE="${PKB_REFRESH_EXCLUDE:-OneToken reqbot-slack}"

targets=()
for dir in "$WORKSPACE"/*/; do
  dir="${dir%/}"
  [[ -d "$dir/.git" ]] || continue
  proj=$(basename "$dir")
  case " $EXCLUDE " in *" $proj "*) echo "[excl]  $proj — excluded"; continue ;; esac
  reason=$(build_reason "$dir")
  last=$(git -C "$dir" log -1 --format=%ct 2>/dev/null || echo 0)
  days=$(( ( $(date +%s) - last ) / 86400 ))
  if [[ "$reason" == error-polluted* || "$reason" == stale* ]]; then
    # An existing PKB means this repo has been analyzed → it is reviewed; a bad
    # one must be rebuilt regardless of how quiet its main branch is (a repo can
    # have a quiet main but active PRs — e.g. finance-system-ui).
    echo "[build] $proj — $reason"
    targets+=("$proj")
  elif [[ "$reason" == "missing" && "$days" -le "$MAX_AGE_DAYS" ]]; then
    echo "[build] $proj — missing (active ${days}d)"
    targets+=("$proj")
  elif [[ -z "$reason" || "$reason" == fresh* ]]; then
    echo "[skip]  $proj — ${reason:-PKB fresh + valid}"
  else
    echo "[skip]  $proj — $reason, main quiet (${days}d); raise PKB_REFRESH_ACTIVE_DAYS to include"
  fi
done

echo "[plan] (re)build ${#targets[@]} repo(s) at concurrency $CONCURRENCY: ${targets[*]:-none}"
$DRY_RUN && { echo "[dry-run] not building"; exit 0; }
[[ ${#targets[@]} -eq 0 ]] && { echo "[refresh] nothing to do"; exit 0; }

# Bounded-concurrency batches (portable; no `wait -n` dependency).
i=0
while [[ $i -lt ${#targets[@]} ]]; do
  pids=()
  for (( j=0; j<CONCURRENCY && i<${#targets[@]}; j++, i++ )); do
    proj="${targets[$i]}"
    ( cd "$WORKSPACE/$proj" \
        && if [[ -n "$FETCH_TOKEN" ]]; then \
          MRA_WORKSPACE="$WORKSPACE" MRA_GIT_FETCH_TOKEN="$FETCH_TOKEN" bash "$MRA" analyze "$proj" > "/tmp/pkb-refresh-$proj.log" 2>&1; \
        else \
          MRA_WORKSPACE="$WORKSPACE" bash "$MRA" analyze "$proj" > "/tmp/pkb-refresh-$proj.log" 2>&1; \
        fi \
        && echo "[done] $proj" \
        || echo "[FAIL] $proj — see /tmp/pkb-refresh-$proj.log" ) &
    pids+=("$!")
  done
  for p in "${pids[@]}"; do wait "$p"; done
done
echo "[refresh] complete"
