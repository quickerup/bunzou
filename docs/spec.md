# Bunzou: A TVM-Native Smart Contract Language — Design Specification

## 1. Problem Statement: Why Not Tolk

Tolk is TON's current official smart contract language — a fork of the
FunC compiler with TypeScript/Rust-inspired syntax, static types,
automatic cell serialization, and message-handling primitives, built to
replace FunC's low-level, untyped tuple-and-stack style. It's a real
improvement over FunC: no more manual `load_uint`/`store_uint` chains, no
more `()`-tuple return values standing in for structs. That's also the
limit of what it fixes. Tolk makes TVM's low-level mechanics more
pleasant to write against; it doesn't change what the type system is
willing to check.

Four gaps motivated this project directly:

1. **Cell layout has no concept of access cost.** Tolk's automatic
   serializer packs struct fields in declaration order. A field read on
   every message handler and a field read once a year can end up
   equally likely to land behind an extra ref-hop, purely by accident of
   how the struct was written — a cost this project's own prototyping
   showed can be a >10x difference in gas for a real storage layout, and
   Tolk has no mechanism to even express the difference, let alone
   optimize for it.
2. **Nothing enforces that value-bearing cells are used exactly once.**
   Forwarding the same Grams-carrying message to two recipients, or
   silently dropping a refund cell, compiles cleanly in Tolk. These bugs
   are currently caught by audit, if they're caught at all.
3. **Continuations and gas cost are fully hidden.** Ordinary function
   syntax gives no way to reason about or bound worst-case execution
   cost short of dropping to inline TVM assembly — there's no path from
   "this handler looks fine" to "this handler is provably within the
   block gas limit under adversarial input."
4. **Asynchronous messaging is a convention, not a checked construct.**
   `send`, `on_bounce`, and reply correlation via query-ids are things a
   Tolk developer writes and gets right by discipline. The compiler
   doesn't know a bounce handler exists to serve a specific outbound
   message, doesn't know whether every live contract state has a defined
   behavior for a given inbound message, and has no way to catch the
   asynchronous-specific bug classes (double-bounce, benign reentrancy
   from an interleaved message, a permanently un-resolved pending
   operation) that don't have analogues in synchronous languages.

None of these are Tolk implementation bugs — they're the predictable
result of extending FunC's syntax without extending what the type system
is asked to prove. Bunzou starts from the opposite direction: instead of
asking "how do we make writing TVM bytecode more pleasant," it asks
"what does a type system have to prove to make TVM's actual execution
model — asynchronous, continuation-based, gas-metered — safe by
construction," and only then designs syntax around that.

## 2. Core Thesis

FunC and Tolk treat TVM as if it were closer to a synchronous environment
than it is, papering over its asynchronous actor model, continuation-based
control flow, and deterministic gas metering with developer convention
rather than compiler-enforced structure.

This architecture is built on one unifying invariant, arrived at by
recognizing that `recv_internal`, `on_reply`, `on_bounce`, and `on_timeout`
are structurally identical:

> **Every contract entrypoint is a total, exhaustively-matched,
> single-consumption function `(State, Message) → State`.**

Everything below is either a facet of proving that property, or an honest
account of where TVM's physics stop the type system from proving more.

## 3. The Pipeline

```
[ Inbound / Reply / Bounce / Timeout Message ]
                 │
                 ▼
 1. Linear Consumption ──────────> value-bearing cells consumed exactly once
                 │                  per execution (double-send / leaked-value safety)
                 ▼
 2. Contextual Effect Inference ──> rejects illegal effects for the current
                 │                  execution context (e.g. re-bouncing)
                 ▼
 3. Monomorphization ─────────────> specializes context-sensitive shared
                 │                  helpers on compile-time-constant args
                 ▼
 4. Algebraic State × Message ────> exhaustiveness over ALL entrypoints,
    Matrix (Totality)               not just reply/bounce -- this is what
                 │                  catches interleaved-message corruption
                 ▼
 5. Concurrent Pending-Op Model ──> c4 generalizes to (BaseState,
    + Lazy-Sweep Timeouts           Map<QueryId, PendingLeg>) once more
                 │                  than one send_recoverable can be
                 │                  outstanding at once; TTL sweep with
                 │                  self-exemption on the current message
                 ▼
 6. Worst-Case Gas (WCG)   ═══════> CROSS-CUTTING, not a pipeline stage:
    Analysis                        every capacity bound, sweep budget, and
                                     gas-sensitive constant anywhere in the
                                     compiler must be derived from this
                                     analyzer, not hand-authored
                 │
                 ▼
          [ TVM Bytecode ]
```

### Layer 1 — Linear Consumption (Intra-Execution)
A value-bearing cell must be consumed exactly once along every path within
one execution. Catches double-send and dropped/leaked refunds. Requires
balanced consumption across `if` branches.

### Layer 2 — Contextual Effect Inference
**Problem:** linear types alone can't see across the bounce fracture — a
bounced message spawns a wholly separate execution with the bounce flag
already cleared, so nothing prevents that execution from promising a
second bounce TVM cannot deliver.
**Mechanism:** effect inference over the interprocedural call graph
(`requires_inbound`), not a wrapper type on values — because the unsafe
action (calling `send_recoverable`) doesn't need to touch any bounced
value to be illegal; it's a property of which code is reachable from
which entrypoint, computed to a fixed point to handle cyclic call graphs.

### Layer 3 — Monomorphization
**Problem:** a shared helper (`send_helper(msg, recoverable)`) gets
marked globally unsafe-for-`on_bounce` even when a specific call site
passes a safe constant argument.
**Mechanism:** specialize on compile-time-constant arguments before
effect inference runs, so the checker only ever sees branch-free code.
A call site passing a genuine runtime variable into an effect-sensitive
parameter gets a distinct `MonomorphizationError`, not conflated with a
bounce-safety violation.

### Layer 4 — Algebraic State × Message Matrix
`c4` is typed as an algebraic sum (`State = Idle | PendingBid | ...`).
**Two distinct guarantees fall out of the same exhaustiveness check:**
- Every state reachable via `send_recoverable` has both `on_reply` and
  `on_bounce` handlers, each a total function (consumes input state once,
  returns a new state on every path — no hand-written "rollback," the
  new state is simply the output of a pure transition).
- **Every entrypoint — including ordinary `recv_internal` — is checked
  against every live state, not just the one it was written assuming.**
  This is what catches the actual TON-specific reentrancy hazard: a
  second `PlaceBid` arriving while the contract is already `PendingBid`.
  Nothing TVM-specific is needed to catch it — it's the same enum
  exhaustiveness check any ML-family language already has, applied to
  `c4` instead of to an ordinary value.

### Layer 5 — Concurrency and Timeouts
**Problem, discovered directly:** a single-tag `State` can only represent
one outstanding async operation system-wide. Real contracts (routers,
multi-leg swaps) need several `send_recoverable`s in flight at once, and
TVM permits their replies/bounces to arrive in any order.
**Mechanism:** generalize `c4` to `(BaseState, Map<QueryId, PendingLeg>)`.
Linear consumption now applies per map key: resolving one leg removes
exactly that entry, verified not to disturb others; duplicate or unknown
`query_id` deliveries are rejected the same way a double-consume is.

**Liveness boundary (not solvable by the type system):** TVM contracts
cannot self-schedule, and an underfunded message can be dropped with no
bounce at all. A pending entry can therefore sit indefinitely if nothing
ever wakes the contract again — this is a real limit of the VM, not a gap
in this design. The mitigation is a **lazy sweep**: every inbound message
runs a compiler-injected preamble that evicts any expired entry (past its
declared `ttl`) into `on_timeout` before processing its own payload, with
the current message's own `query_id` structurally exempted from that
sweep to avoid evicting a legitimate same-tick reply. This buys **bounded
staleness conditional on future activity** — not liveness. Protocols
built on this need an explicit incentive (keeper-bot fee, public sweep
endpoint) for someone to eventually send that triggering message; the
compiler cannot manufacture one.

### Layer 6 — Worst-Case Gas Analysis (Cross-Cutting)
**Problem, discovered directly:** the sweep's cost scales with map size,
so map capacity must be gas-bounded. A capacity bound is only as sound as
the assumed cost of `on_timeout` itself — and an assumed constant of 50
gas turned out, once actually derived from a cost-annotated IR walk of a
realistic handler body, to be 576: **over 11x low**. The capacity that
looked safe under the assumption (1818 concurrent legs) was actually
unsafe past roughly 314.
**Mechanism:** a bottom-up walker over cost-annotated IR — leaf opcode
costs, `if`/`else` as `cond + max(then, else)`, inlined calls (safe only
because monomorphization already removed dynamic dispatch and recursion
is rejected outright as unanalyzable), loops requiring compile-time
constant bounds, map iteration costed as `capacity × per-entry-cost`.
**Governing rule:** no gas number anywhere in the compiler — capacity
bounds, sweep budgets, per-opcode costs — may be hand-authored. Every one
must trace back to this analyzer. A hand-maintained constant is precisely
the failure mode this layer exists to eliminate; leaving even one in
place re-admits the same class of bug that produced the 11x gap.

## 4. Validated Failure Modes

| # | Failure mode | Status | Resolution |
|---|---|---|---|
| 1 | **Silent dead-code trap.** Inferring "pending" status from `send_recoverable` call sites means deleting that call silently strips the requirement for `on_reply`/`on_bounce` elsewhere — the contract compiles clean while permanently stuck. | **Resolved, validated** | Explicit `transient` keyword anchors the requirement at state declaration; bi-directional check flags the exact call site that stopped emitting the async op, plus an orphan warning. |
| 2 | **Benign reentrancy.** A handler written assuming the contract starts `Idle` silently mishandles a message arriving while already `PendingBid`. | **Resolved, validated** | Ordinary enum exhaustiveness applied to *every* entrypoint against *every* live state (Layer 4), not just reply/bounce. |
| 3 | **Self-eviction race.** A lazy-sweep preamble can evict the very entry a same-tick reply is trying to resolve. | **Resolved, validated** | The current message's own `query_id` is exempted from the generic sweep pass. |
| 4 | **Concurrency ceiling.** A single-tag `State` cannot represent more than one outstanding async operation, but real contracts need several at once. | **Resolved, validated** | Generalized `c4` to `Map<QueryId, PendingLeg>` with per-key linear consumption; out-of-order and mixed-outcome resolution both verified correct. |
| 5 | **Phantom gas bound.** Hand-maintained cost constants for handler execution undercounted real cost by >11x, making a "proven safe" capacity actually unsafe. | **Resolved, validated** | WCG analyzer derives every gas-sensitive constant from cost-annotated IR; no hand-authored numbers permitted. |
| 6 | **Greedy bin-packing failure.** Packing struct fields by 1D access frequency alone (ignoring co-occurrence/phase) can pessimize versus naive declaration order, because the greedy bit-packer lets fields spill across intended cluster boundaries. | **Identified; NOT resolved.** A first clustering attempt was built and performed *worse* than plain frequency-sort (279 vs. 29 weighted cost) for exactly this reason. The fix — forcing a hard cell-boundary at cluster edges rather than letting the packer bin-pack across them — was proposed but not built or tested. |

## 5. Example: A Simple Counter Contract

A minimal contract deliberately doesn't need Layer 5 (no concurrent async
legs) or Layer 6 pressure (trivial handler bodies), but it still shows
the core discipline: `c4` as an algebraic state, every handler a total
function, and the compiler checking the full `State × Message` matrix —
here, `Active` and `Locked`, each covering every message the contract
can receive.

```bunzou
state CounterState {
    Active(CounterData),
    Locked(CounterData)
}

struct CounterData {
    count: uint64,
    owner: addr
}

behavior Active {
    on Increment(msg) -> Active {
        consume(self);
        return Active(CounterData { count: self.count + 1, owner: self.owner });
    }

    on Reset(msg) -> Active {
        require(msg.sender == self.owner, "only owner can reset");
        consume(self);
        return Active(CounterData { count: 0, owner: self.owner });
    }

    on Lock(msg) -> Locked {
        require(msg.sender == self.owner, "only owner can lock");
        consume(self);
        return Locked(self);
    }

    on Unlock(msg) -> Active {
        reject("counter is already unlocked");
        return self;
    }
}

behavior Locked {
    on Increment(msg) -> Locked {
        reject("counter is locked");
        return self;
    }

    on Reset(msg) -> Locked {
        reject("counter is locked");
        return self;
    }

    on Lock(msg) -> Locked {
        reject("counter is already locked");
        return self;
    }

    on Unlock(msg) -> Active {
        require(msg.sender == self.owner, "only owner can unlock");
        consume(self);
        return Active(self);
    }
}

get_method get_count(): uint64 {
    return self.count;
}
```

What the compiler actually checks here, per the layers above:

- **Layer 1 (linear consumption):** every `on` handler consumes `self`
  exactly once via `consume(self)` before returning a new state — a
  handler that returned without consuming, or consumed twice, is
  rejected the same way `linear.py` rejected a double-send.
- **Layer 4 (exhaustiveness):** `Increment`, `Reset`, `Lock`, and
  `Unlock` are each defined in *both* `behavior Active` and
  `behavior Locked`. Deleting, say, `Locked`'s `on Reset` handler
  produces exactly `Missing transition: (Locked, Reset)` — the same
  error `surface_syntax.py` produced for the auction contract's
  `Withdraw` case. There is no reachable message this contract leaves
  undefined.
- **No `transient` states, no Layer 5/6 concerns:** nothing here emits
  `send_recoverable`, so there's no pending map, no TTL, and no WCG
  analysis to run — those layers activate only when a contract actually
  needs an outstanding async operation, which a counter never does.

## 6. What Remains Open

- **Cell-layout clustering with hard boundaries** (failure mode 6) — the
  one item in this document without a working prototype behind it.
- **WCG analysis of `send_recoverable`'s own bookkeeping cost** (map
  insert, the twin cost of the send itself) — Layer 6 was validated
  against `on_timeout`'s read side; the write side wasn't run.
- **Surface syntax formalization** — the `state` / `behavior` / `on`
  sketch parses and lowers correctly for the cases tested, but the
  transient-state annotation syntax and its interaction with the
  concurrent `Map<QueryId, PendingLeg>` model (Layer 5) haven't been
  reconciled into one grammar yet.
