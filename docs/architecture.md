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
│ 6. Codegen         │  NEVER PROTOTYPED. Lowers the checked, gas-bound,
│    (→ Fift asm)    │  cell-planned IR to actual TVM instructions.
└───────────────────┘  This is the real compiler, not a checker.
        │
        ▼
┌───────────────────┐
│ 7. Fift → BOC      │  assemble Fift output into a BOC (bag of cells) —
└───────────────────┘  can reuse TON's existing Fift toolchain rather
        │                than reimplementing an assembler
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
| Linear Consumption | `linear.py`, the `Consume`/`Return` logic in `session_types.py` | Logic validated in isolation; never run as a pass over a real parsed AST |
| Contextual Effects | `bounce_check.py` | Same — validated on hand-built call graphs, not parser output |
| Monomorphization | `monomorphize.py` | Same |
| State × Message Matrix | `unified_totality.py`, `surface_syntax.py`'s exhaustiveness check | This one *was* run against real parsed source (the counter contract) — furthest along of any pass |
| Concurrent Pending-Map | `concurrent_legs.py`, `lazy_sweep.py` | Validated as a runtime simulation, not as a compile-time lowering pass — there's a real design gap here: the prototypes modeled *execution*, not *how the type checker statically verifies a Map<QueryId,_>-shaped state before any message ever arrives* |
| WCG / Gas | `gas_bound.py`, `wcg_analyzer.py` | Validated against hand-built IR; never connected to a real function body from parsed source |
| Cell Layout | `layout.py`, `hotfield.py`, `cooccurrence.py` | Has a known unfixed bug (spec §6) — do not wire this in as-is |
| **Codegen** | **Nothing.** No prototype in this session touches TVM instructions, Fift, or bytecode at any point. | **Not started, and the highest-effort remaining piece by a wide margin** |

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
5. **Codegen last, and treat it as its own multi-stage project**: decide
   whether to target Fift text (reusing TON's existing Fift→BOC
   assembler, lower implementation risk) or emit BOC directly
   (higher risk, no dependency on shelling out to Fift). Targeting Fift
   text is the pragmatic choice — it's exactly what Tolk and FunC both
   do, per TON's own docs, so it's a proven target with existing
   tooling rather than a novel one.
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
