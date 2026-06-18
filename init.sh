#!/usr/bin/env bash
# agent-bridge dev bootstrap — idempotent. Safe to run at the start of every session.
set -euo pipefail
cd "$(dirname "$0")"

echo "== agent-bridge init =="

# 1. Node toolchain (reference implementation is TypeScript/Node)
if command -v node >/dev/null 2>&1; then
  echo "node: $(node -v)"
else
  echo "WARN: node not found. Install Node 18+ before implementing packages/."
fi

# 2. Install JS deps once packages exist
if [ -f package.json ]; then
  if [ ! -d node_modules ]; then
    echo "Installing deps..."
    npm install
  else
    echo "deps: present"
  fi
else
  echo "package.json: not yet (pre-implementation phase)"
fi

# 3. Validate that all JSON schemas parse (rules-based check for F0.2)
echo "== validating SPEC/schemas/*.json =="
schema_fail=0
for f in SPEC/schemas/*.json; do
  [ -e "$f" ] || continue
  if node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" 2>/dev/null \
     || python3 -c "import json,sys; json.load(open('$f'))" 2>/dev/null; then
    echo "ok   $f"
  else
    echo "FAIL $f"; schema_fail=1
  fi
done
[ "$schema_fail" = "0" ] && echo "all schemas parse" || { echo "schema parse failure"; exit 1; }

# 4. Run tests if a runner is configured
if [ -f package.json ] && grep -q '"test"' package.json 2>/dev/null; then
  echo "== npm test =="
  npm test --silent || { echo "tests failed"; exit 1; }
fi

echo "== init done =="
