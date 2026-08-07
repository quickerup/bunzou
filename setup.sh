#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/compiler"

echo "== installing dependencies =="
npm install

echo "== compiling stage 1 (lexer/parser + Layer 1 + Layer 4 checker) =="
npx tsc

echo
echo "== running against test/fixtures/counter.bunzou (spec §5, should pass) =="
node dist/index.js test/fixtures/counter.bunzou

echo
echo "== running against test/fixtures/counter-broken.bunzou (Locked.on Reset deleted, should fail) =="
node dist/index.js test/fixtures/counter-broken.bunzou || true

echo
echo "Setup complete. No codegen exists yet — see compiler/src/codegen/README.md."
echo "Compile-check any .bunzou file with:"
echo "  node compiler/dist/index.js path/to/file.bunzou"
