#!/usr/bin/env bash
# LeadGenius smoke: health plus a campaign round-trip against a live server.
# Usage: WID=<workspace-id> bash scripts/smoke.sh (defaults to the demo workspace)
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${LEADGENIUS_URL:-http://127.0.0.1:3200}"
WID="${WID:-cmu82m3af0000niejg46dqd6n}"
# Tenant isolation: every /api route except /health needs a workspace API key.
KEY="${API_KEY:-$(npm run seed:key 2>&1 | grep -oE '[a-z]+_live_[A-Za-z0-9_-]+' | head -1)}"
AUTH=(-H "Authorization: Bearer $KEY")
PASS=0
FAIL=0

check() { # check <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; PASS=$((PASS + 1));
  else echo "  FAIL  $1 (expected '$2', got '$3')"; FAIL=$((FAIL + 1)); fi
}

echo "--- health ---"
check "no key is rejected" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/campaigns?workspaceId=$WID")"
check "health answers" 200 "$(curl -s "${AUTH[@]}" -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/health")"
check "database is up" "up" "$(curl -s "${AUTH[@]}" --max-time 10 "$BASE/api/health" | python3 -c 'import json,sys;print(json.load(sys.stdin)["db"])')"

echo "--- campaigns ---"
CAMP=$(curl -s "${AUTH[@]}" --max-time 10 "$BASE/api/campaigns?workspaceId=$WID")
check "campaigns list" "true" "$(printf '%s' "$CAMP" | python3 -c 'import json,sys;print(isinstance(json.load(sys.stdin)["campaigns"],list))' | tr A-Z a-z)"
STAMP=$(date +%s)
NEW=$(curl -s "${AUTH[@]}" --max-time 15 -X POST "$BASE/api/campaigns" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"name\":\"Smoke $STAMP\",\"goal\":\"smoke\"}")
NEWID=$(printf '%s' "$NEW" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
check "campaign creates (201)" "201" "$(curl -s "${AUTH[@]}" -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/api/campaigns" -H 'Content-Type: application/json' -d "{\"workspaceId\":\"$WID\",\"name\":\"Smoke2 $STAMP\"}")"
check "campaign reads back" "Smoke $STAMP" "$(curl -s "${AUTH[@]}" --max-time 10 "$BASE/api/campaigns/$NEWID" | python3 -c 'import json,sys;print(json.load(sys.stdin)["name"])')"
check "campaign pauses" "PAUSED" "$(curl -s "${AUTH[@]}" --max-time 15 -X PATCH "$BASE/api/campaigns/$NEWID" -H 'Content-Type: application/json' -d '{"status":"PAUSED"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])')"
check "campaign deletes" 200 "$(curl -s "${AUTH[@]}" -o /dev/null -w '%{http_code}' --max-time 10 -X DELETE "$BASE/api/campaigns/$NEWID")"

echo "--- contacts ---"
CONTACT=$(curl -s "${AUTH[@]}" --max-time 15 -X POST "$BASE/api/contacts" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"email\":\"smoke.$STAMP@probe.test\",\"firstName\":\"Smoke\"}")
CID=$(printf '%s' "$CONTACT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
check "contact creates with email" "smoke.$STAMP@probe.test" "$(printf '%s' "$CONTACT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["email"])')"
check "contact deletes" 200 "$(curl -s "${AUTH[@]}" -o /dev/null -w '%{http_code}' --max-time 10 -X DELETE "$BASE/api/contacts/$CID")"

echo "--- analytics ---"
check "overview answers" "true" "$(curl -s "${AUTH[@]}" --max-time 15 "$BASE/api/analytics/$WID?type=overview&days=30" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("totalContacts" in d)' | tr A-Z a-z)"

echo "--- enrollments (the core loop: campaign -> sequence -> contact) ---"
ECAMP=$(curl -s "${AUTH[@]}" --max-time 15 -X POST "$BASE/api/campaigns" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"name\":\"Enroll $STAMP\",\"goal\":\"smoke\"}")
ECAMPID=$(printf '%s' "$ECAMP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
SEQ=$(curl -s "${AUTH[@]}" --max-time 15 -X POST "$BASE/api/sequences" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"campaignId\":\"$ECAMPID\",\"name\":\"Smoke seq $STAMP\",\"channel\":\"EMAIL\",\"stepsConfig\":[{\"stepNumber\":1,\"channel\":\"EMAIL\",\"delayHours\":0}]}")
SEQID=$(printf '%s' "$SEQ" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
check "sequence materializes steps" "1" "$(printf '%s' "$SEQ" | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("steps",[])))')"
ECONTACT=$(curl -s "${AUTH[@]}" --max-time 15 -X POST "$BASE/api/contacts" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"email\":\"enroll.$STAMP@probe.test\",\"firstName\":\"Enroll\"}")
ECID=$(printf '%s' "$ECONTACT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
ENR_BODY=$(mktemp)
ENR_CODE=$(curl -s "${AUTH[@]}" --max-time 20 -o "$ENR_BODY" -w '%{http_code}' -X POST "$BASE/api/enrollments" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"contactId\":\"$ECID\",\"sequenceId\":\"$SEQID\",\"campaignId\":\"$ECAMPID\"}")
check "contact enrolls (201)" "201" "$ENR_CODE"
ENRID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("enrollment",{}).get("id",""))' "$ENR_BODY")
rm -f "$ENR_BODY"
check "enrollment created with id" "true" "$(printf '%s' "$ENRID" | python3 -c 'import sys;print(len(sys.stdin.read().strip())>0)' | tr A-Z a-z)"
check "double enrollment refused (409)" "409" "$(curl -s "${AUTH[@]}" -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE/api/enrollments" -H 'Content-Type: application/json' -d "{\"workspaceId\":\"$WID\",\"contactId\":\"$ECID\",\"sequenceId\":\"$SEQID\",\"campaignId\":\"$ECAMPID\"}")"
curl -s "${AUTH[@]}" --max-time 10 -X DELETE "$BASE/api/enrollments/$ENRID" > /dev/null
curl -s "${AUTH[@]}" --max-time 10 -X DELETE "$BASE/api/contacts/$ECID" > /dev/null
curl -s "${AUTH[@]}" --max-time 10 -X DELETE "$BASE/api/sequences/$SEQID" > /dev/null
curl -s "${AUTH[@]}" --max-time 10 -X DELETE "$BASE/api/campaigns/$ECAMPID" > /dev/null

echo "--- ai draft-reply (model drafts, human sends; degrades without a key) ---"
ACAMP=$(curl -s "${AUTH[@]}" --max-time 15 -X POST "$BASE/api/campaigns" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"name\":\"AI $STAMP\",\"goal\":\"smoke\"}")
ACAMPID=$(printf '%s' "$ACAMP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
ASEQ=$(curl -s "${AUTH[@]}" --max-time 15 -X POST "$BASE/api/sequences" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"campaignId\":\"$ACAMPID\",\"name\":\"AI seq $STAMP\",\"channel\":\"EMAIL\",\"stepsConfig\":[{\"stepNumber\":1,\"channel\":\"EMAIL\",\"delayHours\":0}]}")
ASEQID=$(printf '%s' "$ASEQ" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
ACONTACT=$(curl -s "${AUTH[@]}" --max-time 15 -X POST "$BASE/api/contacts" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"email\":\"ai.$STAMP@probe.test\",\"firstName\":\"Aiprobe\"}")
ACID=$(printf '%s' "$ACONTACT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
AENR=$(curl -s "${AUTH[@]}" --max-time 20 -X POST "$BASE/api/enrollments" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"contactId\":\"$ACID\",\"sequenceId\":\"$ASEQID\",\"campaignId\":\"$ACAMPID\"}")
AENRID=$(printf '%s' "$AENR" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("enrollment",{}).get("id",""))')
DRAFT=$(curl -s "${AUTH[@]}" --max-time 20 -X POST "$BASE/api/ai/draft-reply" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"enrollmentId\":\"$AENRID\",\"reply\":\"Sounds interesting, tell me more\",\"productContext\":\"smoke\",\"knownFacts\":[]}")
check "draft-reply answers (200)" "200" "$(curl -s "${AUTH[@]}" -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE/api/ai/draft-reply" -H 'Content-Type: application/json' -d "{\"workspaceId\":\"$WID\",\"enrollmentId\":\"$AENRID\",\"reply\":\"ok\",\"knownFacts\":[]}")"
check "positive reply classified" "positive" "$(printf '%s' "$DRAFT" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("signal",{}).get("kind",""))')"
check "draft or honest no-key" "true" "$(printf '%s' "$DRAFT" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("drafted",False) is True or d.get("configured",True) is False)' | tr A-Z a-z)"
OPT=$(curl -s "${AUTH[@]}" --max-time 20 -X POST "$BASE/api/ai/draft-reply" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"enrollmentId\":\"$AENRID\",\"reply\":\"Please remove me from your list\"}")
check "opt-out honoured without a model" "unsubscribe" "$(printf '%s' "$OPT" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("action",""))')"
check "draft-reply rejects anon" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$BASE/api/ai/draft-reply" -H 'Content-Type: application/json' -d '{}')"
curl -s "${AUTH[@]}" --max-time 10 -X DELETE "$BASE/api/enrollments/$AENRID" > /dev/null
curl -s "${AUTH[@]}" --max-time 10 -X DELETE "$BASE/api/contacts/$ACID" > /dev/null
curl -s "${AUTH[@]}" --max-time 10 -X DELETE "$BASE/api/sequences/$ASEQID" > /dev/null
curl -s "${AUTH[@]}" --max-time 10 -X DELETE "$BASE/api/campaigns/$ACAMPID" > /dev/null

echo "================================"
echo "  $PASS passed, $FAIL failed"
echo "================================"
[[ "$FAIL" -eq 0 ]]
