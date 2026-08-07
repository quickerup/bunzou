# Unified Semantic IR — not built

Stage 3 of the pipeline (architecture.md §2). Right now every pass in
`../passes/` either doesn't exist yet or (for linear.ts / exhaustiveness.ts)
operates directly on the parser's AST. That's a stopgap: architecture.md §3
is explicit that the six prototypes were "six disconnected object graphs,"
and letting each ported pass invent its own intermediate shape reproduces
that problem instead of fixing it. Design this IR schema before porting
Layer 2 (effects) or Layer 3 (monomorphization) — both need a call graph
that AST-walking alone doesn't give you cleanly.
