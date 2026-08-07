# Codegen

This directory implements the first slice of Bunzou's codegen.

## FunC Text as Target

Unlike the original architectural plan (target Fift), codegen targets FunC text. This was a deliberate deviation due to environmental constraints (lack of local Fift binaries). By lowering to FunC and compiling with `@ton-community/func-js`, we leverage a real compiler that produces verifiable BOCs and provides actual compile-time errors instead of silently failing with hand-rolled TVM assembly.

## Current Scope

This handles the core functionality needed to compile the baseline `counter.bunzou` test case. 
- Structs and States are laid out plainly (no automatic packing yet). 
- `require` translates to `throw_unless`.
- `reject` translates to `throw`.
- Variants currently share a single payload struct. 
- CRC32 op codes handle message routing via `recv_internal`.
