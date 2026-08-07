# Codegen — not built

Nothing in this directory exists yet. Per `docs/architecture.md` §3, no
prototype from the design session touched TVM instructions, Fift, or
bytecode at any point. This is the highest-effort remaining piece of the
compiler, by a wide margin, and per §4 step 5 it comes *after* the unified
IR, all five semantic passes, and the WCG/gas pass are real — not before.

When this starts, see architecture.md §4 step 5 for the Fift-text-vs-BOC
decision (short version: target Fift text, reuse TON's Fift→BOC assembler,
same choice Tolk and FunC both made).
