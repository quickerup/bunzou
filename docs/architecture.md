# Bunzou Compiler: Architecture Blueprint

This is not the compiler. It's the pipeline design for building it — what
each stage takes in, what it produces, which of this session's prototypes
it absorbs, and specifically what has never been prototyped at all
(codegen, in full).

## 1. Why This Has To Exist Before Blueprint Integration Means Anything

Blueprint's contract is narrow and language-agnostic: a `.compile.ts`
file that returns a `Cell`. That's the entire interface. It doesn't
validate, doesn't type-check, doesn't know what a `transient` state is —
it just needs something that can be called from Node/TypeScript and
hands back compiled bytecode. Everything upstream of that `Cell` is the
compiler's job, entirely.

## 2. Pipeline Overview

```
.bunzou source files
        │
        ▼
┌───────────────────┐
│ 1. Lexer / Parser  │  produces a real AST (not the regex-based
└───────────────────┘  extraction used in prototyping)
        │
        ▼
┌───────────────────┐
│ 2. Name Resolution │  resolves state/behavior/message identifiers,
│    & Type Checking │  struct field types, builds the symbol table
└───────────────────┘  every later pass reads from
        │
        ▼
┌────────────────────────────┐
│ 3. Unified Semantic IR      │  ONE typed IR, not six disconnected
└────────────────────────────┘  object graphs. Layers 1–5 from the
        │                        spec become passes OVER this IR:
        │                        - linear consumption check
        │                        - contextual effect inference
        │                        - monomorphization
        │                        - State × Message exhaustiveness
        │                        - concurrent pending-map lowering
        ▼
┌───────────────────┐
│ 4. Cost-Annotated  │  WCG analyzer (Layer 6) walks the now-checked,
│    IR / WCG Pass   │  now-monomorphized IR and derives every gas
└───────────────────┘  bound; rejects unbounded loops/recursion here
        │
        ▼
┌───────────────────┐
│ 5. Cell Layout     │  lowers each `struct`/`state` variant to actual
│    Planner         │  cell bit/ref layout (the access-frequency /
└───────────────────┘  clustering work — still has an open bug, see
        │                spec §6, that must be fixed before this stage
        │                can be trusted)
        ▼
┌───────────────────┐
│ 6. Codegen         │  Lowers the checked, gas-bound, cell-planned IR
│    (→ FunC text)   │  to FunC text. This deviates from the original
└───────────────────┘  Fift target plan because Fift binaries are
        │                environmentally constrained, and FunC gives us
        │                real verifiable bytecode compilation.
        ▼
┌───────────────────┐
│ 7. FunC → BOC      │  uses @ton-community/func-js to compile the FunC
└───────────────────┘  output into a BOC (bag of cells).
        ▼
┌───────────────────┐
│ 8. Node/TS-        │  a thin wrapper (mirroring tolk-js's shape:
│    Invokable        │  `runBunzouCompiler({...}) -> {status, fiftCode,
│    Wrapper           │  codeBoc64, codeHashHex}`) is what a
└───────────────────┘  `.compile.ts` file actually calls
        │
        ▼
   Blueprint's Cell  ──> Sandbox tests, deployment, everything
                          Blueprint already does, unmodified
```

## 3. What Each Stage Absorbs From This Session's Prototypes

| Stage | Absorbs | Status |
|---|---|---|
| Lexer/Parser | `surface_syntax.py`'s brace-matching + header regex | Proof of concept only — no expression grammar, no literals beyond what the test contracts needed, no error recovery |
| Type Checking | Nothing yet — every prototype assumed types were already resolved (e.g. `addr`, `coins`, `uint64` were just dict lookups in `layout.py`) | Not started |
| Linear Consumption | `linear.py`, the `Consume`/`Return` logic in `session_types.py` | Running as a pass over the real parsed AST (`compiler/src/typecheck/checker.ts`), path-sensitive across `if`/`else`/`else if` — every execution path through a handler body is walked independently and must balance `consume(self)`. Still scoped to what the grammar has: no loops, no helper functions, no interprocedural calls |
| Contextual Effects | `bounce_check.py` | Same — validated on hand-built call graphs, not parser output |
| Monomorphization | `monomorphize.py` | Same |
| State × Message Matrix | `unified_totality.py`, `surface_syntax.py`'s exhaustiveness check | This one *was* run against real parsed source (the counter contract) — furthest along of any pass |
| Concurrent Pending-Map | `concurrent_legs.py`, `lazy_sweep.py` | Validated as a runtime simulation, not as a compile-time lowering pass — there's a real design gap here: the prototypes modeled *execution*, not *how the type checker statically verifies a Map<QueryId,_>-shaped state before any message ever arrives* |
| WCG / Gas | `gas_bound.py`, `wcg_analyzer.py` | Validated against hand-built IR; never connected to a real function body from parsed source |
| Cell Layout | `layout.py`, `hotfield.py`, `cooccurrence.py` | Has a known unfixed bug (spec §6) — do not wire this in as-is |
| **Codegen** | **AST → FunC text → BOC.** | **Implemented for base language features.** Targets FunC text instead of Fift (a pragmatic choice for verification). |

## 4. The Honest Sequencing

Given the table above, the order that avoids wasted work is:

1. **Real parser + type checker first.** Every later pass needs a typed
   AST to operate on; right now every "pass" is really a standalone demo
   fed synthetic input by hand. This is standard compiler-frontend work
   (recursive descent or a parser generator, a symbol table, a
   unification-based or simple nominal type checker) — not novel to
   Bunzou, and the least interesting part, but nothing else is real
   until it exists.
2. **Port the five validated semantic passes onto the real AST**, in the
   order the pipeline diagram shows, since each depends on the previous
   one's output (monomorphization needs effect inference's call graph;
   exhaustiveness checking needs monomorphized, branch-free code).
3. **Fix the cell-layout clustering bug** (spec §6) before wiring that
   stage in — shipping the known-worse-than-baseline version would
   silently regress every contract's gas cost.
4. **Formalize the concurrent-map lowering as a static check**, not just
   a runtime simulation — this is genuinely unfinished design work, not
   just an implementation gap, and should happen before codegen depends
   on it.
5. **Codegen**: Decided to target FunC text instead of Fift text. This was pulled forward in priority because it's required for deploying contracts that don't need layers 2/3/5/6 (like the counter). Targeting FunC text allows us to use `@ton-community/func-js` directly to get real bytecode, rather than hand-rolling Fift or TVM assembly without a verifier.
6. **The Node/TS wrapper and `.compile.ts` integration is the easy part,
   last.** Once step 5 produces real Fift/BOC output from real `.bunzou`
   source, wrapping it to match `tolk-js`'s call shape is small,
   mechanical work — at that point, and only at that point, "does it
   work with Blueprint" becomes a yes.

## 5. What This Session Has Not Resolved, Stated Plainly

The six prototypes are correct proofs of *individual mechanisms*. They
are not a compiler, and they're not close to one in terms of remaining
effort — a real parser and type checker, formal codegen, and stitching
five independently-validated passes into one coherent IR each represent
substantially more work than any single prototype built so far. The
value of this session was proving the *design* is sound before paying
that cost, not shortcutting the cost itself.
