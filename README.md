# Bunzou

A state-machine-shaped smart contract language for TON, designed around
linear resource consumption and an algebraic State × Message matrix that's
checked for exhaustiveness at compile time.

**Status: pre-alpha.** This repo contains a working compiler for the core
language features. The compiler features a complete frontend (lexer, parser,
name resolution, Layer 1 linear consumption analysis across conditional
branches, and Layer 4 State × Message exhaustiveness checking) and a codegen
backend. Codegen lowers Bunzou AST to FunC text, which is then compiled into
verifiable BOCs via `@ton-community/func-js`. You can write and compile
contracts today. The automated test suite (42+ tests) covers parsing, semantic
analysis, codegen, and full `@ton/sandbox` integration testing.

## Start here

- `docs/spec.md` — the language design and its six-layer semantic model
- `docs/developer-guide.md` — how to think in Bunzou, worked examples
- `docs/architecture.md` — the compiler pipeline and design decisions

## Repo layout

```
docs/            the three design documents
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

Runs the compiler frontend (parser and type checker) against the spec's own
counter contract (`docs/spec.md` §5). To see the entire end-to-end pipeline
including codegen and sandbox execution, run `./demo.sh` from the repository
root instead.

## Testing

```
cd compiler
npm install
npm test
```

Compiles `src/` and `test/` together and runs the result with Node's
built-in test runner. Covers the lexer, parser (including expression
precedence and control flow shapes), semantic analysis, codegen lowering,
BOC compilation, and sandbox execution — both `.bunzou` fixtures under
`test/fixtures/` and inline synthetic cases.
