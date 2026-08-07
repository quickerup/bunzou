# Writing Bunzou: A Developer's Guide

This is a practical companion to the Bunzou language specification. The
spec proves what the compiler checks; this document is about the
day-to-day discipline of writing contracts that pass those checks
without fighting them — and about the habits, mostly inherited from
Tolk and from synchronous programming generally, that will actively
work against you here.

## 1. The One Mindset Shift Everything Else Follows From

In Tolk, and in FunC before it, you write a contract by writing
functions: `recv_internal` does something, maybe calls a helper, maybe
sends a message. The mental model is procedural — code that runs,
top to bottom, with occasional branches.

**In Bunzou, you are not writing procedures. You are writing a state
machine, and the compiler is checking that the machine is total.**
Every entrypoint you define is a transition `(State, Message) → State`.
The question to ask before writing a single line of a handler isn't
"what should happen when this message arrives" — it's "what is the
current state, and what does this message mean in each state the
contract could actually be in." If you're used to Tolk, this feels like
extra ceremony for the first contract you write and becomes the only
way you want to think about it by the third.

The practical consequence: **design the `state` block before you write
a single handler.** If you don't know all the states your contract can
be in before you start writing behavior, you don't yet understand the
contract well enough to write it safely — and Bunzou will make that
visible immediately (a missing state means missing behaviors means
compile errors) instead of leaving it to be discovered in production.

## 2. What To Do

**Model persistent state as an algebraic type, and make illegal states
unrepresentable.** If a field only makes sense while an auction is
pending, it belongs inside a `PendingBid(PendingData)` variant, not as
an `Option`-typed field on a single flat struct that's supposed to
represent every phase of the contract's life at once. Tolk gives you
one storage struct and trusts you to track which fields are meaningful
right now. Bunzou wants that distinction to be a type.

**Treat compiler rejections as the state machine telling you something
true.** `Missing transition: (Locked, Reset)` is not a formality to
silence — it's the compiler telling you that a real message can arrive
while your contract is in a real state you haven't thought about yet.
The correct response is almost always to add an explicit handler (even
if that handler is just `reject(...)`), not to find a way to make the
error go away structurally.

**Mark every state that's entered via `send_recoverable` as
`transient`, explicitly, at declaration.** Don't rely on the compiler
inferring pending-state status from where a `send_recoverable` happens
to appear in the code. Explicit declaration is what lets the compiler
catch the case where a refactor deletes the async call but leaves the
now-orphaned `on_bounce`/`on_reply` handlers behind — inference alone
lets that fail silently.

**Design for concurrency, not just asynchrony, from the start of any
contract that sends more than one outbound message per logical
operation.** If a contract can plausibly have two or more
`send_recoverable`s outstanding at once — a router, a multi-leg
operation, anything fanning out to several counterparties — model
pending operations as a keyed collection (`Map<QueryId, PendingLeg>`)
up front. Retrofitting concurrency onto a design that assumed a single
global pending state is a rewrite, not a patch.

**Declare a `ttl` on every transient state and implement `on_timeout` as
a real recovery path, not a formality.** Ask, specifically: what happens
to the value or the contract's usability if this operation never
resolves? If the honest answer is "it's stuck forever," that's a
protocol design gap, and Bunzou will not paper over it for you the way
a synchronous mental model quietly does.

**Let the compiler own gas accounting.** Write handler bodies with
bounded loops (compile-time-constant bounds) and let the Worst-Case Gas
analyzer derive the real cost. Don't estimate a handler's cost yourself
and hardcode it anywhere — that's the exact failure mode (an assumed
constant of 50 gas against a real cost of 576) that the language exists
to eliminate.

**Think about hot fields when you design a storage struct.** Which
fields does every message handler touch, versus which are read once in
a rare code path? Group and order accordingly, or use whatever
annotation the compiler's cell-layout planner exposes once it exists
(see the spec's open items) — declaration order is not a layout
strategy, it's an accident.

## 3. What To Never Do

**Never assume a sent message will be answered.** No `await`-shaped
construct in Bunzou should trick you into thinking of `send_recoverable`
as a function call that returns. It is a fire, and *maybe* a reply or a
bounce arrives *if* the network delivers it and the contract is later
woken by some other message. Code that has no path forward when a reply
never comes is a fund-lock waiting to happen, regardless of how clean
the type-checked happy path looks.

**Never write a bounce handler that assumes it can hand a problem to a
second bounce.** A message that has already bounced has its bounce flag
cleared — TVM will not bounce it a second time. If `on_bounce` sends a
new `send_recoverable` and *that* fails, the value is gone, silently.
Bounces are a single-hop safety net, not a chained unwinding mechanism
the way exceptions are in a synchronous language.

**Never treat "it compiled" as "it's live."** Bunzou's exhaustiveness
and linearity checks prove safety — if a state transition happens, it
happens correctly, exactly once, with no dangling partial state. They
do not, and structurally cannot, prove that a given transition *will*
happen in a world where messages can be silently dropped for
insufficient attached value. Every protocol built on a transient state
needs an honest answer to "what happens if this never resolves," and
that answer has to come from protocol design (timeouts, keeper
incentives, public sweep endpoints), not from the type system.

**Never write an unbounded loop or recursive helper and expect the
compiler to find a way to accept it.** This isn't a temporary
limitation to work around with a clever pattern — it's a direct
consequence of gas being a static, provable property in this language.
If a loop's bound depends on runtime state, restructure it as
map-capacity-bounded iteration or reject the design.

**Never hand-manage query-id correlation.** If you find yourself writing
code that stores a query-id in a side table and manually matches it
against incoming replies, you're re-implementing what the transient
state / pending-map machinery already does correctly, without the
compiler's exhaustiveness or linearity guarantees. That's a Tolk habit;
in Bunzou it's a sign you haven't modeled the state correctly yet.

**Never assume declaration order in a storage struct is neutral.** It
isn't free, and unlike in Tolk, Bunzou's own tooling can tell you
exactly what it costs — use that instead of guessing.

**Never treat a `reject(...)` branch as a lesser or temporary form of
handling a message.** An explicit rejection that returns a valid state
is a complete, correct answer to "what happens if this message arrives
here" — it's not a placeholder for "handle this properly later." A
contract with only reject-and-return-self branches for every
currently-unsupported case is safer than one with gaps, and often
that's the right permanent design, not a stopgap.

## 4. Tolk Habit → Bunzou Habit

| In Tolk, you would... | In Bunzou, instead... |
|---|---|
| Write one flat storage struct and track "which fields are valid right now" mentally | Declare an algebraic `state` type; invalid combinations are unrepresentable |
| Add an `if` to `recv_internal` for a new message type and move on | Add a handler to *every* `behavior` block the message is reachable from, and let missing ones fail to compile |
| Store a query-id in a variable and match it by hand in `on_bounce` | Declare a `transient` state with a `ttl`; let the compiler enforce `on_reply`/`on_bounce`/`on_timeout` coverage |
| Estimate whether a loop or handler will run out of gas by testing on testnet | Let the WCG analyzer derive a provable worst-case bound at compile time |
| Treat a bounce as roughly like an exception you can propagate | Treat a bounce as a single, final, non-chainable rollback signal |
| Order struct fields however they were designed on paper | Order or annotate struct fields by how often each is actually read |
| Consider a contract "done" once it compiles and passes a few manual test messages | Consider a contract's *safety* proven by compilation, and separately, explicitly, design for what happens if a pending operation never resolves |

## 5. A Short Checklist Before Writing Any Handler

1. What are *all* the states this contract can be in? Is the `state`
   block exhaustive, or are you about to discover a missing one via a
   compile error?
2. For the message you're about to handle, does it need a response to
   be meaningful (`transient`, needs `ttl` + `on_timeout`), or is it a
   single-execution transition (plain `on`)?
3. If this could have more than one instance outstanding at once, is
   the pending state a `Map<QueryId, _>`, or did you just assume there's
   only ever one?
4. Does every branch of this handler consume `self` exactly once and
   return a state on every path?
5. If this operation never gets a reply, what happens? Say the answer
   out loud before you write the happy path.
