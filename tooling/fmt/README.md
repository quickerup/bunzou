# bunzou-fmt — not built

Formatter. Same rationale as vscode-bunzou: cheap relative to the
compiler, and only needs the parser's AST (compiler/src/frontend/parser.ts)
to round-trip pretty-printed source, not the semantic passes.
