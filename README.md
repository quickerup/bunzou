# Bunzou

A state-machine-shaped smart contract language for TON, designed around
linear resource consumption and an algebraic State × Message matrix that's
checked for exhaustiveness at compile time.

**Status: pre-alpha, not a working compiler yet.** This repo currently
contains a design (`docs/spec.md`), a pipeline plan (`docs/architecture.md`),
and a stage-1 frontend (lexer, parser, name resolution, two of six semantic
passes) that runs against real `.bunzou` source. It does not yet produce
TVM bytecode. See `docs/architecture.md` §5 for what's unresolved, stated
plainly, and `compiler/src/codegen/README.md` for the largest remaining gap.

## Start here

- `docs/spec.md` — the language design and its six-layer semantic model
- `docs/developer-guide.md` — how to think in Bunzou, worked examples
- `docs/architecture.md` — the compiler pipeline, what's built vs. not,
  and the build order this repo follows

## Repo layout

```
docs/            the three design documents, unmodified
compiler/        the actual compiler source + tests
integration/     Blueprint (.compile.ts) integration, currently a stub
examples/        buildable .bunzou example contracts
tooling/         editor support, formatter — independent of compiler internals
```

## Building

```
cd compiler
npm install
npx tsc
node dist/index.js test/fixtures/counter.bunzou
```

Runs the stage-1 frontend against the spec's own counter contract
(`docs/spec.md` §5). No codegen exists, so this validates and type-checks
only — it does not produce a deployable contract.
