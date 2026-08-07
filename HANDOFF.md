# Handoff — pick up here

Written mid-session because the previous session ran out of tokens. This
documents exact state so the next session doesn't have to re-derive it.

## Repo location
`/data/data/com.termux/files/home/downloads/bunzou` (unzipped from
`~/downloads/bunzou.zip`). Git repo initialized this session (it had none
before). One commit exists (`ae31b3b`, the original scaffold baseline).
**Everything since that commit is uncommitted in the working tree** — see
`git status` output below. Nothing has been committed since, on purpose
(never commit without the user explicitly asking).

```
 M .gitignore
 M README.md
 M compiler/package.json
 M compiler/src/frontend/ast.ts
 M compiler/src/frontend/lexer.ts
 M compiler/src/frontend/parser.ts
 M compiler/src/typecheck/checker.ts
 M docs/architecture.md
?? compiler/package-lock.json
?? compiler/test/checker.test.ts
?? compiler/test/fixtures/conditional-balanced.bunzou
?? compiler/test/fixtures/conditional-unbalanced.bunzou
?? compiler/test/lexer.test.ts
?? compiler/test/parser.test.ts
?? compiler/tsconfig.test.json
?? demo.sh
```

Also `node_modules/` now has new deps installed (see below) but that's
gitignored, not part of the diff.

## What's DONE and verified working (session 1 of this arc)

1. **Git init'd**, `.gitignore` added (`node_modules/`, `dist/`, `dist-test/`).
2. **Verified baseline stage-1 compiler builds and runs** — `cd compiler &&
   npm install && npx tsc && node dist/index.js test/fixtures/counter.bunzou`
   → OK. `counter-broken.bunzou` → correctly reports
   `Missing transition: (Locked, Reset)`.
3. **Real test suite added**: `compiler/test/{lexer,parser,checker}.test.ts`,
   39 cases, run via Node's built-in test runner (`npm test`). Had to route
   around a `ts-node` 10.9.2 vs installed `typescript` 7.0.2 API break — the
   fix was to NOT use ts-node at all. Instead: `tsconfig.test.json` compiles
   `src/` + `test/` together to `dist-test/`, then
   `node --test dist-test/test/*.test.js` runs them. This is wired up as
   `npm test` (via a `pretest` script that runs the test build). Fixture
   paths in test files use `path.join(process.cwd(), 'test', 'fixtures')`,
   NOT `__dirname` (because `__dirname` at runtime points into `dist-test/`,
   not the source tree — fixtures aren't copied there).
4. **Grammar extended with `if`/`else`/`else if`** (lexer keywords, AST
   `IfStmt` node, parser `parseIfStmt`).
5. **Layer 1 linear-consumption checker rewritten to be path-sensitive**
   (`compiler/src/typecheck/checker.ts`, `walkBlock` function) — walks every
   execution path through a handler body, splitting/rejoining at each `if`,
   requiring `consume(self)` to balance on every path independently. This
   replaced the old "flat statement list, single path" version. All existing
   tests still pass; new fixtures
   (`test/fixtures/conditional-{balanced,unbalanced}.bunzou`) and ~10 new
   checker tests cover branch cases.
6. **`demo.sh`** at repo root: builds the compiler, walks `counter.bunzou`
   through lex → parse → typecheck stage by stage with real output at each
   step, proves the checker catches a real bug (deleted transition), runs
   the full test suite. Ends with an explicit, honest statement that no
   codegen exists yet. **This script works today** — run it to confirm
   nothing regressed:
   ```
   /data/data/com.termux/files/home/downloads/bunzou/demo.sh
   ```

Full clean-room verification was done at the end of session 1 (`rm -rf
dist dist-test node_modules && npm install && npm test` → 39/39 pass).

## What's IN PROGRESS (session 2, interrupted — this is the resume point)

The user asked to build **real codegen** — turning checked `.bunzou` source
into an actual deployable, executable TON contract. This had never been
prototyped in the project before (confirmed: `compiler/src/codegen/` was
just a README saying "not built").

### The chosen approach (decided and validated this session)

**Do not hand-roll raw TVM opcodes / Fift assembly from memory.** No local
`fift`/`func` binaries exist in this environment, and hand-encoding TVM
bytecode with no reference to verify against is high-risk (subtly wrong
bytecode that "looks plausible" but silently produces garbage). This is a
deliberate deviation from `docs/architecture.md`'s stated plan ("target
Fift text") — the reason is purely environmental, not disagreement with the
plan, and needs to be written into `docs/architecture.md` honestly when
this work resumes (**not yet done** — see gaps below).

Instead: **lower the checked AST to real FunC source text**, then compile
that through `@ton-community/func-js` (npm package, confirmed installable,
confirmed network-reachable in this environment). This package bundles the
*actual* reference func + fift + BOC-assembler toolchain compiled to WASM —
not a reimplementation, the real thing, cross-platform, no native binary
needed. This gives genuinely correct bytecode with a real compiler's error
messages to iterate against, rather than unverifiable hand-rolled opcodes.

Then prove it actually **executes** (not just compiles) using `@ton/sandbox`
— a real TVM emulator — by deploying the compiled contract and sending it
real messages, asserting on real state changes.

### Toolchain verification done this session (all confirmed working)

- `npm install @ton-community/func-js @ton/core` (regular deps) and
  `npm install --save-dev @ton/sandbox` (devDep) — all installed cleanly
  into `compiler/node_modules`, zero vulnerabilities. **This is reflected in
  `compiler/package.json` and `compiler/package-lock.json`, which are
  already modified/added in the working tree** (see git status above) — no
  need to redo this step, just `cd compiler && npm install` to restore
  `node_modules` if it's missing.
- **Important gotcha discovered**: `compileFunc()` from `@ton-community/func-js`
  fails with a cryptic Fift error (`` `main` procedure not defined ``) if the
  FunC source has no `recv_internal` function defined — e.g. a source with
  *only* a `method_id` get-method fails. Adding a (possibly empty)
  `() recv_internal(int msg_value, cell in_msg_full, slice in_msg_body) impure { }`
  fixes it. This is not a real problem for us since every Bunzou contract's
  codegen output will have a real `recv_internal` anyway — just noting the
  gotcha so it doesn't cost time to rediscover.
- Confirmed `compilerVersion()` → func 0.4.6 (recent, funcFiftLib commit
  2025-10-10).
- Was in the middle of checking whether `@ton/core` / `@ton/sandbox` /
  `@ton-community/func-js` are ESM-only or have CJS-compatible `main` entry
  points, since `compiler/tsconfig.json` currently targets
  `"module": "CommonJS"`. Partial finding: all three packages have
  `"main": "dist/index.js"` in package.json but **no `"type": "module"` or
  `"exports"` field was confirmed present or absent** — the grep command run
  only checked for those exact keys and the output was ambiguous/cut off.
  **Next action: re-run and actually read
  `node_modules/@ton/core/package.json`,
  `node_modules/@ton/sandbox/package.json`, and
  `node_modules/@ton-community/func-js/package.json` in full** to determine
  if plain `require()` from the CommonJS-compiled compiler works, or if
  dynamic `import()` is needed instead (this matters a lot for how
  `compiler/src/codegen/index.ts` gets structured — CJS `require` of an
  ESM-only package throws `ERR_REQUIRE_ESM`).

### Design work done (not yet written to any file — exists only in prior
### conversation turns, needs to be re-derived or is summarized fully here)

**Message wire format** (Bunzou never defined one — this is new design, not
just plumbing): each message name (`Increment`, `Reset`, `Lock`, `Unlock`,
etc.) gets a 32-bit op code, computed via CRC32 of the message name
(standard convention used across real FunC/Tolk contracts, e.g. `op::foo =
crc32("foo")`). No additional payload fields are supported yet (Bunzou's
grammar doesn't have message field declarations at all — `on Increment(msg)`
doesn't declare what's inside `msg`). Plan: implement a small, independently
tested CRC32 function (`compiler/src/codegen/crc32.ts`), verify it against
the standard test vector (`crc32("123456789") === 0xCBF43926`) before
trusting it for anything — this was Task #8, not started.

**Persistent storage (c4) layout**: `state_tag (1 bit) ++ count (uint64) ++
owner (MsgAddress slice, via load_msg_addr/store_slice)`. Tag is the
variant's index within its `StateDecl.variants` array (`Active`=0,
`Locked`=1 for the counter contract). Design assumes/requires exactly one
`StateDecl` per program (Bunzou's grammar technically allows more, but
there's only one persistent-storage concept per contract — codegen should
error clearly if it sees more than one, not silently pick one).

**Shared payload struct assumption**: both `Active` and `Locked` wrap the
same `CounterData` struct in the counter fixture. Plan was to require (for
now) that *all* variants of a state share one payload struct shape, and
error clearly if they don't — not attempt a general per-variant layout yet.

**Primitive type mapping**: `uint64` → 64-bit uint field; `addr` → slice via
`load_msg_addr`/`store_slice` (NOT decoded further — carried opaquely);
`bool` → 1 bit; `coins`/`string` → **not implemented, should error clearly
if used** (out of scope for this slice).

**recv_internal dispatch structure**: nested `if`/`elseif` — outer level
keyed on `state_tag` (one branch per `BehaviorDecl`, ordered by declared
state-variant order, last branch as bare `else` since exhaustiveness
checking already guarantees full coverage), inner level keyed on the 32-bit
op code read from the first 32 bits of the incoming message body, one
branch per `OnHandler`. A hand-written linear `if`/`elseif` chain, not a
FunC dictionary jump table — simpler, fully correct, just less optimal;
that's an explicitly fine, statable tradeoff for now (matches this
project's existing culture of naming tech debt instead of hiding it — see
e.g. the cell-layout bug already documented in `docs/spec.md` §6).

**`msg.sender` access**: parsed once at the top of `recv_internal` from
`in_msg_full` via the standard idiom
`slice cs = in_msg_full.begin_parse(); int flags = cs~load_uint(4); slice sender = cs~load_msg_addr();`
and bound to a local FunC variable `sender`. Any `msg.<field>` other than
`.sender` should be a clear codegen error (not silently ignored) — the
language doesn't define other message fields yet.

**Statement/expression lowering rules** (scoped tightly to exactly what
`counter.bunzou` uses — anything outside this list should be a clear
`CodegenError`, never silently dropped or guessed at):
- `consume(self)` → no-op at codegen time (compile-time-only linearity
  marker already validated by the checker).
- `require(cond, "msg text")` → `throw_unless(<code>, <cond>);`. The string
  text has no on-chain representation (TVM has no strings) — drop it,
  document that error messages are compile-time diagnostics only, not
  encoded on-chain. Use an auto-incrementing exit code per call site
  starting around 400 (exact value doesn't matter, just needs to be
  distinguishable for debugging).
- `reject("msg text")` → unconditional `throw(<code>);`, auto-incrementing
  from a different base (~500) so require/reject codes don't collide. This
  is semantically correct: throwing before `save_data()` automatically
  rolls back the whole transaction, which is exactly "return the input
  state unchanged" — matches `docs/developer-guide.md`'s description of
  `reject(...)` as a complete, valid, permanent answer.
- `ReturnStmt` → NOT translated as a literal "return a value." Its
  `handler.returnType` (already validated by the checker to name a real
  state variant) gives the target tag authoritatively. The return
  *expression* only needs to supply field values:
  - `Call(callee=Ident(variantName), args=[StructLit{...}])` → use the
    struct literal's field expressions directly.
  - `Call(callee=Ident(variantName), args=[SelfExpr])` (e.g. `Locked(self)`)
    → fields = current self fields, unchanged.
  - bare `SelfExpr` (e.g. the reject branches' `return self;`) → same,
    fields unchanged (though on reject paths this is dead code after the
    `throw`, so it never actually needs lowering).
  - anything else → `CodegenError`, not a guess.
  Then emit `save_data(tag, <fields...>); return ();` once per handler,
  at the actual return point (not per source `ReturnStmt`, since only one
  will execute at runtime per the branch-walk that Layer 1 already proved
  is well-formed).
- `FieldAccess(SelfExpr, 'count')` → local var `count`;
  `FieldAccess(SelfExpr, 'owner')` → local var `owner`;
  `FieldAccess(Ident(paramName /* 'msg' */), 'sender')` → local var `sender`.
  Any other field access → `CodegenError`.
- `BinaryOp`: arithmetic/comparison operators map directly EXCEPT `&&`/`||`
  should lower to `&`/`|` (bitwise), not FunC's boolean operators — safer
  across FunC versions since comparisons already produce canonical -1/0,
  and bitwise AND/OR give correct logical results on canonical booleans
  without depending on whichever FunC version bundled in func-js supports
  `&&`/`||` sugar.
- `BinaryOp('==' or '!=')` where **both** operands are slice-typed (i.e.
  `self.owner` or `msg.sender`, detected structurally, not via a real type
  checker since one doesn't exist yet) → must NOT use plain `==`/`!=`.
  Needs a helper `equal_slices(slice a, slice b) inline { return
  a.slice_hash() == b.slice_hash(); }` emitted once per compiled contract,
  and calls lowered to `equal_slices(a, b)`. **This was flagged as
  uncertain** — whether FunC 0.4.6's `==` works directly on slices at all
  wasn't confirmed either way from memory; the plan was to just try both
  and let the real compiler's error output settle it (that's the whole
  point of using a real compiler instead of hand-rolled opcodes — iterate
  against real errors, don't guess from memory). **Not yet attempted.**
- `get_method` decls → straightforward FunC `method_id` functions (FunC
  auto-assigns the standard CRC16-based get-method id from the function
  name when you write `int get_count() method_id { ... }` — no manual id
  management needed, FunC's compiler does this itself).

None of the above has been written to a file yet. It's a complete enough
design to start implementing directly from this document without
re-deriving it — that was the intent of writing it down here in this much
detail.

## Task tracker state (as of interruption)

Tasks #1–#6 (session 1, frontend/tests/if-else) are all `completed`.
Tasks #7–#12 (session 2, codegen) exist and are `pending`/`in_progress`:

- **#7 "Add codegen toolchain deps"** — `in_progress`. Actually DONE in
  substance (deps installed, verified working) — just needs to be marked
  `completed` next session, or re-verify `npm install` still resolves
  cleanly first.
- **#8 "Design and document the message wire format"** — `pending`. Design
  decided (see above, CRC32 op codes), nothing implemented or written to a
  file yet. Do this first — `crc32.ts` + test, per the plan above.
- **#9 "Implement AST-to-FunC lowering"** — `pending`. Full design above,
  nothing written yet. This is the bulk of the remaining work.
- **#10 "Wire up compilation via func-js to real BOC"** — `pending`.
  Mechanically small once #9 exists — call `compileFunc()`, handle
  `status: 'error'` by surfacing `result.message` clearly (don't swallow).
- **#11 "Prove it executes: sandbox integration test"** — `pending`. Needs
  a `Contract`-interface wrapper class for `@ton/sandbox`'s
  `blockchain.openContract()` (see `@ton/sandbox`'s README, already read
  this session — key points: `Blockchain.create()`, `blockchain.treasury()`
  for a funded sender, `provider.internal(via, {value, body})` to send,
  `provider.get(methodName, [])` for get-methods; methods on the wrapper
  class must start with `get`/`send` and take `provider: ContractProvider`
  as first arg). Test plan: deploy, Increment increments count, Reset
  requires owner + zeroes count, Lock/Unlock transitions, Locked rejects
  Increment/Reset/Lock, non-owner Reset/Lock/Unlock rejected, `get_count`
  returns the right value.
- **#12 "Update demo.sh and docs honestly"** — `pending`. Add a real
  compile+deploy+execute stage to `demo.sh`; update
  `README.md`/`docs/architecture.md`/`compiler/src/codegen/README.md` to
  state plainly: codegen exists now, targets FunC text (not raw Fift/TVM
  asm — and why), and its exact scope limits (everything itemized in the
  "Design work done" section above should end up documented, not just
  known). This is the point where the deliberate architecture.md deviation
  (FunC-text target instead of Fift-text) needs to actually be written down
  — **it is currently only decided, not documented anywhere in the repo.**

## Immediate next steps, in order

1. `cd /data/data/com.termux/files/home/downloads/bunzou/compiler && npm install`
   to make sure `node_modules` is intact (it may or may not have persisted;
   `package.json`/`package-lock.json` already have the right deps either
   way).
2. Finish the CJS/ESM interop check that was interrupted — read the full
   `package.json` of `@ton/core`, `@ton/sandbox`, `@ton-community/func-js`
   (specifically `"type"` and `"exports"` fields), and confirm whether
   `compiler/src/codegen/index.ts` can use plain `require`/`import`
   (CommonJS-compiled) or needs dynamic `import()`.
3. Implement `compiler/src/codegen/crc32.ts` + a unit test using the
   standard `crc32("123456789") === 0xCBF43926` vector (task #8).
4. Implement the AST → FunC lowering per the full design above (task #9) —
   `compiler/src/codegen/lower.ts`, throwing a `CodegenError` (never
   silently guessing) for anything outside the documented scope.
5. Wire up `compileFunc()` (task #10), iterating on real compiler errors —
   especially resolve the open `==` on slices question by just trying it.
6. Write the `@ton/sandbox` integration test (task #11) and get it green.
7. Update `demo.sh` and the docs (task #12), including writing down the
   FunC-vs-Fift deviation honestly.

## Standing project conventions to keep following

- Never commit without the user explicitly asking (nothing has been
  committed since the baseline import commit, on purpose).
- Never silently drop or guess at unsupported language constructs in
  codegen — throw a clear, named error. This project's whole culture (see
  `docs/spec.md` §6, `docs/architecture.md` §5) is stating gaps plainly
  instead of hiding them; codegen should follow the same discipline.
- Verify claims by actually running things (build, test, or a smoke script)
  before stating something works — this was done rigorously in session 1
  and should continue.
- `docs/architecture.md`'s stated sequencing (real frontend → passes →
  cell-layout fix → concurrent-map formalization → codegen → wrapper) was
  intentionally reordered here: codegen was pulled forward because the user
  asked for it directly, and it's legitimate to do so *for contracts that
  don't need Layers 2/3/5/6* (the spec says outright the counter contract
  doesn't need them: no `transient` states, no concurrency). This is not a
  silent shortcut — it should be named as a scoping decision in the docs
  update (task #12), same as everything else.
