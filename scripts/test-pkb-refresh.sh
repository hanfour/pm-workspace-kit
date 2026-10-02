#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKB_REFRESH="$SCRIPT_DIR/pkb-refresh.sh"
REAL_PATH="$PATH"
REAL_GIT="$(command -v git)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pkb-refresh-test.XXXXXX")"
PROJECT="example-ui-$$"
WORKSPACE="$TMP/workspace"
PROJECT_DIR="$WORKSPACE/$PROJECT"
PKB_DIR="$PROJECT_DIR/.mra/pkb"
ORIGIN="$TMP/origin.git"
SEED="$TMP/seed"
BIN="$TMP/bin"
FAKE_TOKEN="test-fetch-token"
RUN_STDOUT=""
RUN_STDERR=""

cleanup() {
  rm -f "/tmp/pkb-refresh-$PROJECT.log"
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  [[ "$1" == *"$2"* ]] || fail "expected output to contain: $2"
}

assert_not_contains() {
  [[ "$1" != *"$2"* ]] || fail "output unexpectedly contained a secret"
}

assert_file_value() {
  local actual
  actual="$(<"$1")"
  [[ "$actual" == "$2" ]] || fail "unexpected value in $1: $actual"
}

write_meta() {
  local sha="$1" ref="${2:-origin/main}"
  mkdir -p "$PKB_DIR"
  printf '{"sourceRef":"%s","sourceSha":"%s"}\n' "$ref" "$sha" > "$PKB_DIR/meta.json"
}

run_refresh() {
  local mode="${1:-}" rc=0
  if [[ -n "$mode" ]]; then
    env bash "$PKB_REFRESH" "$mode" > "$TMP/stdout" 2> "$TMP/stderr" || rc=$?
  else
    env bash "$PKB_REFRESH" > "$TMP/stdout" 2> "$TMP/stderr" || rc=$?
  fi
  [[ "$rc" -eq 0 ]] || {
    cat "$TMP/stdout" >&2
    cat "$TMP/stderr" >&2
    fail "pkb-refresh exited with status $rc"
  }
  RUN_STDOUT="$(<"$TMP/stdout")"
  RUN_STDERR="$(<"$TMP/stderr")"
}

mkdir -p "$BIN" "$WORKSPACE" "$TMP/home"
export HOME="$TMP/home"
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
export PATH="$BIN:$REAL_PATH"
export REAL_GIT
export MRA_WORKSPACE="$WORKSPACE"
export MRA_BIN="$BIN/mra"
export MRA_CALLS="$TMP/mra-calls"
export MRA_TOKEN_CAPTURE="$TMP/mra-token-capture"
export GH_CALLS="$TMP/gh-calls"
export GH_FAIL=0
export GH_FAKE_TOKEN="$FAKE_TOKEN"
export PKB_REFRESH_GH_USER="example-user"
export PKB_REFRESH_CONCURRENCY=1
export GIT_LS_REMOTE_FAIL=0
export GIT_LS_REMOTE_TRACE="$TMP/git-ls-remote-trace"
unset MRA_GIT_FETCH_TOKEN GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0

cat > "$BIN/git" <<'GIT_STUB'
#!/usr/bin/env bash
set -euo pipefail
is_ls_remote=false
for arg in "$@"; do
  [[ "$arg" == "ls-remote" ]] && is_ls_remote=true
done
if [[ "$is_ls_remote" == true ]]; then
  [[ "${GIT_LS_REMOTE_FAIL:-0}" != 1 ]] || exit 72
  if [[ -n "${GIT_LS_REMOTE_TRACE:-}" ]]; then
    printf '%s|%s|%s|%s\n' "${GIT_CONFIG_COUNT-}" "${GIT_CONFIG_KEY_0-}" \
      "${GIT_CONFIG_VALUE_0-}" "$*" >> "$GIT_LS_REMOTE_TRACE"
  fi
fi
exec "$REAL_GIT" "$@"
GIT_STUB
chmod +x "$BIN/git"

cat > "$BIN/mra" <<'MRA_STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MRA_CALLS"
printf '%s\n' "${MRA_GIT_FETCH_TOKEN-<unset>}" > "$MRA_TOKEN_CAPTURE"
MRA_STUB
chmod +x "$BIN/mra"

cat > "$BIN/gh" <<'GH_STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_CALLS"
if [[ "${GH_FAIL:-0}" == 1 ]]; then
  printf '%s\n' "$GH_FAKE_TOKEN" >&2
  exit 1
fi
printf '%s\n' "$GH_FAKE_TOKEN"
GH_STUB
chmod +x "$BIN/gh"

"$REAL_GIT" init -q --bare --initial-branch=main "$ORIGIN"
"$REAL_GIT" init -q "$SEED"
"$REAL_GIT" -C "$SEED" config user.name "Test User"
"$REAL_GIT" -C "$SEED" config user.email "test@example.invalid"
printf 'base\n' > "$SEED/source.txt"
"$REAL_GIT" -C "$SEED" add source.txt
"$REAL_GIT" -C "$SEED" commit -qm base
"$REAL_GIT" -C "$SEED" branch -M main
"$REAL_GIT" -C "$SEED" remote add origin "$ORIGIN"
"$REAL_GIT" -C "$SEED" push -q -u origin main
"$REAL_GIT" clone -q "$ORIGIN" "$PROJECT_DIR"
"$REAL_GIT" -C "$PROJECT_DIR" remote set-url origin git@github.com:acme/example-ui.git
"$REAL_GIT" config --global url."file://$ORIGIN".insteadOf https://github.com/acme/example-ui.git
BASE_SHA="$("$REAL_GIT" -C "$SEED" rev-parse HEAD)"

# A token resolved through gh is passed to the mra child but never printed.
run_refresh
assert_file_value "$GH_CALLS" "auth token --user example-user"
assert_file_value "$MRA_TOKEN_CAPTURE" "$FAKE_TOKEN"
assert_not_contains "$RUN_STDOUT$RUN_STDERR" "$FAKE_TOKEN"

# An explicitly supplied token takes precedence over gh auth.
before_gh="$(wc -l < "$GH_CALLS" | tr -d ' ')"
rm -rf "$PKB_DIR"
export MRA_GIT_FETCH_TOKEN="$FAKE_TOKEN"
run_refresh
after_gh="$(wc -l < "$GH_CALLS" | tr -d ' ')"
[[ "$before_gh" == "$after_gh" ]] || fail "gh ran despite an existing fetch token"
assert_file_value "$MRA_TOKEN_CAPTURE" "$FAKE_TOKEN"
assert_not_contains "$RUN_STDOUT$RUN_STDERR" "$FAKE_TOKEN"
unset MRA_GIT_FETCH_TOKEN

# Failed gh auth warns once and still runs mra without a token.
export GH_FAIL=1
rm -rf "$PKB_DIR"
before_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
run_refresh
after_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
[[ "$after_mra" -eq $((before_mra + 1)) ]] || fail "mra did not run after gh auth failed"
assert_file_value "$MRA_TOKEN_CAPTURE" "<unset>"
assert_contains "$RUN_STDERR" "could not get a GitHub fetch token"
assert_not_contains "$RUN_STDOUT$RUN_STDERR" "$FAKE_TOKEN"
export GH_FAIL=0 PKB_REFRESH_GH_USER=""

# A moved remote ref is stale even while the local clone has not fetched it.
printf 'remote update\n' >> "$SEED/source.txt"
"$REAL_GIT" -C "$SEED" add source.txt
"$REAL_GIT" -C "$SEED" commit -qm update
"$REAL_GIT" -C "$SEED" push -q origin main
REMOTE_SHA="$("$REAL_GIT" -C "$SEED" rev-parse HEAD)"
write_meta "$BASE_SHA"
before_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
run_refresh
after_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
[[ "$after_mra" -eq $((before_mra + 1)) ]] || fail "moved remote ref did not trigger a rebuild"
assert_contains "$RUN_STDOUT" "stale (origin/main moved)"

# The matching remote sha skips analysis and authenticates ls-remote by header.
write_meta "$REMOTE_SHA"
touch -t 200001010000 "$PKB_DIR/meta.json"
export MRA_GIT_FETCH_TOKEN="$FAKE_TOKEN"
before_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
run_refresh
after_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
[[ "$before_mra" == "$after_mra" ]] || fail "unchanged remote ref triggered a rebuild"
assert_contains "$RUN_STDOUT" "PKB fresh + valid"
auth_value="$(printf 'x-access-token:%s' "$FAKE_TOKEN" | base64 | tr -d '\n')"
assert_contains "$(<"$GIT_LS_REMOTE_TRACE")" "http.https://github.com/.extraheader"
assert_contains "$(<"$GIT_LS_REMOTE_TRACE")" "$auth_value"
assert_not_contains "$(<"$GIT_LS_REMOTE_TRACE")" "$FAKE_TOKEN"
unset MRA_GIT_FETCH_TOKEN

# ls-remote failure falls back to the old local commit-time rule.
write_meta "$REMOTE_SHA"
touch -t 200001010000 "$PKB_DIR/meta.json"
export GIT_LS_REMOTE_FAIL=1
before_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
run_refresh
after_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
[[ "$after_mra" -eq $((before_mra + 1)) ]] || fail "local-time fallback did not rebuild stale PKB"
assert_contains "$RUN_STDOUT" "stale (origin/main ls-remote failed; local commit newer)"
export GIT_LS_REMOTE_FAIL=0

# Legacy metadata without sourceRef continues to use the old time rule.
printf '{"project":"example-ui"}\n' > "$PKB_DIR/meta.json"
touch -t 200001010000 "$PKB_DIR/meta.json"
before_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
run_refresh
after_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
[[ "$after_mra" -eq $((before_mra + 1)) ]] || fail "legacy metadata did not use the local-time rule"
assert_contains "$RUN_STDOUT" "[build] $PROJECT"
assert_contains "$RUN_STDOUT" "stale"

# Dry-run reports source-ref staleness and never invokes mra.
write_meta "$BASE_SHA"
before_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
run_refresh --dry-run
after_mra="$(wc -l < "$MRA_CALLS" | tr -d ' ')"
[[ "$before_mra" == "$after_mra" ]] || fail "dry-run invoked mra"
assert_contains "$RUN_STDOUT" "stale (origin/main moved)"
assert_contains "$RUN_STDOUT" "[dry-run] not building"

printf 'PASS: pkb-refresh token, source-ref staleness, fallback, legacy, and dry-run\n'
