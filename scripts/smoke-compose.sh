#!/usr/bin/env bash
# Container smoke test: build, first start, localhost-only binding, persistence across
# restart and down/up, and a full backup → damage → restore cycle.
#
#   scripts/smoke-compose.sh                       # uses: docker compose
#   COMPOSE="podman compose" scripts/smoke-compose.sh
#   COMPOSE=podman-compose scripts/smoke-compose.sh
#
# Runs as a separate compose project on its own port and volume, so it never touches a
# real installation. Everything it creates is removed at the end.
set -euo pipefail

cd "$(dirname "$0")/.."
read -r -a COMPOSE <<<"${COMPOSE:-docker compose}"
PROJECT=kitchen-loop-smoketest
PORT=${SMOKE_PORT:-18090}
BASE="http://localhost:$PORT"
WORK=$(mktemp -d)
export KITCHEN_LOOP_PORT=$PORT

c() { "${COMPOSE[@]}" -p "$PROJECT" "$@"; }
PASSED=0
SKIPPED=0
pass() { PASSED=$((PASSED + 1)); printf '✓ %s\n' "$*"; }
skip() { SKIPPED=$((SKIPPED + 1)); printf -- '- skipped: %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
cleanup() { c down -v >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);console.log($1)})"; }
wait_healthy() {
  for _ in $(seq 1 60); do
    curl -fsS "$BASE/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  c logs || true
  fail "app did not become healthy on $BASE"
}
put_recipes() {  # $1 = revision, $2 = JSON array of recipes
  curl -fsS -X PUT "$BASE/api/data" -H 'Content-Type: application/json' \
    -d "{\"baseRevision\":$1,\"recipes\":$2}" >/dev/null
}

c down -v >/dev/null 2>&1 || true  # leftovers from an interrupted run
c up -d --build >/dev/null 2>&1 || { c up -d --build; fail "compose up failed"; }
wait_healthy
pass "built and started with: ${COMPOSE[*]}"

data=$(curl -fsS "$BASE/api/data")
[ "$(json 'd.recipes.length' <<<"$data")" = 18 ] || fail "expected 18 first-run recipes"
pass "first start created the data file with 18 first-run recipes"

uid=$(c exec -T kitchen-loop id -u | tr -d '\r')
[ "$uid" != 0 ] || fail "container runs as root"
pass "container process runs as non-root uid $uid"

# The published port must be on loopback only, and foreign Host headers are refused.
if command -v ss >/dev/null; then
  listeners=$(ss -Hltn "sport = :$PORT" | awk '{print $4}')
  grep -qE "^(127\.0\.0\.1|\[::1\]):$PORT$" <<<"$listeners" || fail "unexpected listeners: $listeners"
  ! grep -qE "^(0\.0\.0\.0|\*|\[::\]):$PORT$" <<<"$listeners" || fail "port is published on all interfaces"
  pass "host port $PORT listens on loopback only ($listeners)"
else
  skip "loopback-only listener check (the 'ss' tool is not installed)"
fi
lan_ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1 || true)
if [ -n "$lan_ip" ]; then
  if curl -fsS --max-time 3 "http://$lan_ip:$PORT/api/health" >/dev/null 2>&1; then fail "reachable via $lan_ip"; fi
  pass "not reachable via the LAN address $lan_ip"
else
  skip "LAN reachability check (no non-loopback IPv4 address found)"
fi
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: attacker.example' "$BASE/api/health")
[ "$code" = 421 ] || fail "foreign Host header got $code, expected 421"
pass "requests addressed to another hostname are refused (421)"

# A second server on the same volume (another container) must refuse to start.
if c run --rm -T kitchen-loop node server.js >"$WORK/second.log" 2>&1; then fail "second server on the same volume started"; fi
grep -q 'Only one server may use a data directory' "$WORK/second.log" || { cat "$WORK/second.log"; fail "second server failed for the wrong reason"; }
pass "a second server container on the same volume refuses to start"

# A frozen (paused) app keeps the lock: another server still cannot start.
c pause >/dev/null 2>&1
if c run --rm -T kitchen-loop node server.js >"$WORK/paused.log" 2>&1; then c unpause >/dev/null 2>&1; fail "server started while the app was paused"; fi
c unpause >/dev/null 2>&1
grep -q 'Only one server may use a data directory' "$WORK/paused.log" || { cat "$WORK/paused.log"; fail "paused check failed for the wrong reason"; }
wait_healthy
pass "a paused app keeps the lock; a second server still refuses to start"

rev=$(json 'd.revision' <<<"$data")
recipes=$(json 'JSON.stringify([...d.recipes,{id:"smoke-1",name:"Smoke Test Soup",tags:"Dinner",ingredients:"Water, Salt"}])' <<<"$data")
put_recipes "$rev" "$recipes"
pass "added a recipe through the API"

c restart >/dev/null 2>&1
wait_healthy
curl -fsS "$BASE/api/data" | grep -q 'Smoke Test Soup' || fail "recipe lost after restart"
pass "recipe survived a container restart"

# A killed app (no clean shutdown) leaves its lock socket behind; restarting needs no wait.
c kill -s KILL >/dev/null 2>&1 || c kill >/dev/null 2>&1
c start >/dev/null 2>&1
wait_healthy
curl -fsS "$BASE/api/data" | grep -q 'Smoke Test Soup' || fail "recipe lost after SIGKILL"
pass "after SIGKILL the app restarts immediately with its data"

c down >/dev/null 2>&1
c up -d >/dev/null 2>&1
wait_healthy
curl -fsS "$BASE/api/data" | grep -q 'Smoke Test Soup' || fail "recipe lost after down/up"
pass "recipe survived down + up (container recreated, volume kept)"

# Backup → make a change → restore → change is gone and backup content is back.
c exec -T kitchen-loop node server.js backup >"$WORK/backup.json"
grep -q 'Smoke Test Soup' "$WORK/backup.json" || fail "backup does not contain the recipe"
pass "backup taken ($(wc -c <"$WORK/backup.json") bytes)"

data=$(curl -fsS "$BASE/api/data")
put_recipes "$(json 'd.revision' <<<"$data")" '[]'
[ "$(curl -fsS "$BASE/api/data" | json 'd.recipes.length')" = 0 ] || fail "could not delete recipes"
pass "simulated data loss: all recipes deleted"

if c run --rm -T kitchen-loop node server.js restore <"$WORK/backup.json" >"$WORK/busy.log" 2>&1; then fail "restore ran while the app was running"; fi
grep -q 'Only one server may use a data directory' "$WORK/busy.log" || { cat "$WORK/busy.log"; fail "restore refused for the wrong reason"; }
pass "restore refuses to run while the app is using the data"

echo '{"not": "a backup"' | { c stop >/dev/null 2>&1; c run --rm -T kitchen-loop node server.js restore 2>"$WORK/bad.err" && fail "invalid backup was accepted" || true; }
grep -q 'not valid JSON' "$WORK/bad.err" || { cat "$WORK/bad.err"; fail "invalid backup error message missing"; }
pass "a damaged backup is refused and nothing is changed"

c run --rm -T kitchen-loop node server.js restore <"$WORK/backup.json" 2>"$WORK/restore.log" || { cat "$WORK/restore.log"; fail "restore failed"; }
c start >/dev/null 2>&1
wait_healthy
restored=$(curl -fsS "$BASE/api/data")
[ "$(json 'd.recipes.length' <<<"$restored")" = 19 ] || fail "restore did not bring back 19 recipes"
grep -q 'Smoke Test Soup' <<<"$restored" || fail "restored data is missing the added recipe"
pass "restore brought back all 19 recipes ($(tr '\n' ' ' <"$WORK/restore.log"))"

# Damaged data file: the app must refuse to start, and restoring the automatic .bak (the
# version before the most recent save) recovers. Make one ordinary save first.
rev=$(curl -fsS "$BASE/api/data" | json 'd.revision')
curl -fsS -X PUT "$BASE/api/changelog-seen" -H 'Content-Type: application/json' -d "{\"baseRevision\":$rev,\"version\":1}" >/dev/null
c stop >/dev/null 2>&1
c run --rm -T kitchen-loop sh -c 'echo "{ damaged" > /data/kitchen-loop.json' >/dev/null 2>&1
c start >/dev/null 2>&1
sleep 5
if curl -fsS --max-time 3 "$BASE/api/health" >/dev/null 2>&1; then fail "app started on a damaged data file"; fi
c logs 2>&1 | grep -q 'is not valid JSON' || fail "damaged-file error not reported in logs"
pass "damaged data file: app refuses to start and explains why"
c stop >/dev/null 2>&1
c run --rm -T kitchen-loop sh -c 'node server.js restore < /data/kitchen-loop.json.bak' >/dev/null 2>&1 || fail "recovery from .bak failed"
c start >/dev/null 2>&1
wait_healthy
[ "$(curl -fsS "$BASE/api/data" | json 'd.recipes.length')" = 19 ] || fail "recovery from .bak lost data"
c exec -T kitchen-loop sh -c 'ls /data' | grep -q '^kitchen-loop.json.damaged-' || fail "the damaged data file was not kept aside"
pass "recovered from the automatic .bak copy with all 19 recipes; the damaged file was kept aside"

echo "All container checks passed: $PASSED passed, $SKIPPED skipped (19 in total)."
