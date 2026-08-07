import {
  Program, StateDecl, StructDecl, BehaviorDecl, OnHandler, Stmt, Expr, Position,
} from '../frontend/ast';

export interface Diagnostic {
  message: string;
  pos: Position;
}

const PRIMITIVE_TYPES = new Set(['uint64', 'addr', 'coins', 'bool', 'string']);

export interface SymbolTable {
  structs: Map<string, StructDecl>;
  states: Map<string, StateDecl>;
  // variant name -> owning state decl name
  variantOwner: Map<string, string>;
}

export function buildSymbolTable(program: Program, diags: Diagnostic[]): SymbolTable {
  const structs = new Map<string, StructDecl>();
  const states = new Map<string, StateDecl>();
  const variantOwner = new Map<string, string>();

  for (const d of program.decls) {
    if (d.kind === 'StructDecl') {
      if (structs.has(d.name)) {
        diags.push({ message: `duplicate struct '${d.name}'`, pos: d.pos });
      }
      structs.set(d.name, d);
    } else if (d.kind === 'StateDecl') {
      if (states.has(d.name)) {
        diags.push({ message: `duplicate state '${d.name}'`, pos: d.pos });
      }
      states.set(d.name, d);
      for (const v of d.variants) {
        if (variantOwner.has(v.name)) {
          diags.push({
            message: `state variant '${v.name}' declared in both '${variantOwner.get(v.name)}' and '${d.name}'`,
            pos: v.pos,
          });
        }
        variantOwner.set(v.name, d.name);
      }
    }
  }

  // struct field types must resolve
  for (const s of structs.values()) {
    for (const f of s.fields) {
      if (!PRIMITIVE_TYPES.has(f.type) && !structs.has(f.type)) {
        diags.push({
          message: `struct '${s.name}' field '${f.name}': unknown type '${f.type}'`,
          pos: f.pos,
        });
      }
    }
  }

  // state variant payload types must resolve to a struct
  for (const st of states.values()) {
    for (const v of st.variants) {
      if (v.payloadType && !structs.has(v.payloadType)) {
        diags.push({
          message: `state '${st.name}' variant '${v.name}': unknown payload type '${v.payloadType}'`,
          pos: v.pos,
        });
      }
    }
  }

  return { structs, states, variantOwner };
}

// ---- name resolution over behavior/get_method decls ----

function checkNameResolution(program: Program, sym: SymbolTable, diags: Diagnostic[]) {
  for (const d of program.decls) {
    if (d.kind !== 'BehaviorDecl') continue;
    if (!sym.variantOwner.has(d.stateVariant)) {
      diags.push({
        message: `behavior block references undeclared state variant '${d.stateVariant}'`,
        pos: d.pos,
      });
    }
    for (const h of d.handlers) {
      if (!sym.variantOwner.has(h.returnType)) {
        diags.push({
          message: `handler '${d.stateVariant}.${h.message}' returns undeclared state variant '${h.returnType}'`,
          pos: h.pos,
        });
      }
    }
  }
}

// ---- Layer 4: State x Message exhaustiveness ----
// Ported from the logic validated in unified_totality.py / surface_syntax.py's
// exhaustiveness check (spec §5, §4 failure mode #2). Reproduces the exact
// error shape the spec cites: "Missing transition: (Locked, Reset)".

function checkExhaustiveness(program: Program, sym: SymbolTable, diags: Diagnostic[]) {
  const behaviors = program.decls.filter(d => d.kind === 'BehaviorDecl') as BehaviorDecl[];

  // union of every message name reachable via ANY behavior block
  const allMessages = new Set<string>();
  for (const b of behaviors) {
    for (const h of b.handlers) allMessages.add(h.message);
  }

  const byVariant = new Map<string, BehaviorDecl>();
  for (const b of behaviors) {
    if (byVariant.has(b.stateVariant)) {
      diags.push({
        message: `duplicate behavior block for state variant '${b.stateVariant}'`,
        pos: b.pos,
      });
    }
    byVariant.set(b.stateVariant, b);
  }

  // check every declared state variant against every reachable message —
  // not just the messages that variant's own block happens to define.
  for (const variantName of sym.variantOwner.keys()) {
    const behavior = byVariant.get(variantName);
    const defined = new Set((behavior?.handlers ?? []).map(h => h.message));
    for (const msg of allMessages) {
      if (!defined.has(msg)) {
        diags.push({
          message: `Missing transition: (${variantName}, ${msg})`,
          pos: behavior?.pos ?? { line: 0, col: 0 },
        });
      }
    }
  }
}

// ---- Layer 1: linear consumption ----
// Ported from linear.py's Consume/Return logic (validated in isolation) onto
// real handler bodies. Now that the grammar has `if`/`else` (parser.ts), this
// walks every execution path through the handler body — spec Layer 1
// requires balanced consumption across if branches, not just a single
// straight-line body.
//
// Approach: walk each block carrying a set of "open" path states (one per
// execution path that has reached this point without yet returning). A
// return closes every currently-open path with its accumulated
// consume/reject state; an `if` splits the open paths into a then-set and an
// else-set (an absent `else` behaves like an empty block, i.e. the state
// passes through unchanged) and both are walked independently, since they're
// genuinely different executions that must each satisfy the same rule.

interface PathState {
  consumeCount: number;
  hasReject: boolean;
}

interface ClosedPath extends PathState {
  pos: Position; // the return statement that terminated this path
}

interface BlockResult {
  closed: ClosedPath[]; // paths that hit `return` inside this block
  open: PathState[]; // paths that fell through without returning
}

function isCall(e: Expr, name: string): boolean {
  return e.kind === 'Call' && e.callee.kind === 'Ident' && e.callee.name === name;
}

function isConsumeSelf(e: Expr): boolean {
  return isCall(e, 'consume') && e.kind === 'Call' && e.args.length === 1 && e.args[0].kind === 'SelfExpr';
}

function applyExprStmt(st: PathState, expr: Expr): PathState {
  if (isConsumeSelf(expr)) return { consumeCount: st.consumeCount + 1, hasReject: st.hasReject };
  if (isCall(expr, 'reject')) return { consumeCount: st.consumeCount, hasReject: true };
  return st;
}

function walkBlock(stmts: Stmt[], initial: PathState[]): BlockResult {
  let open = initial;
  const closed: ClosedPath[] = [];

  for (const stmt of stmts) {
    if (open.length === 0) break; // every path already returned; rest is dead code

    if (stmt.kind === 'ReturnStmt') {
      for (const st of open) closed.push({ ...st, pos: stmt.pos });
      open = [];
    } else if (stmt.kind === 'ExprStmt') {
      open = open.map(st => applyExprStmt(st, stmt.expr));
    } else if (stmt.kind === 'IfStmt') {
      const thenResult = walkBlock(stmt.thenBranch, open.map(st => ({ ...st })));
      const elseInitial = open.map(st => ({ ...st }));
      const elseResult = stmt.elseBranch
        ? walkBlock(stmt.elseBranch, elseInitial)
        : { closed: [] as ClosedPath[], open: elseInitial };
      closed.push(...thenResult.closed, ...elseResult.closed);
      open = [...thenResult.open, ...elseResult.open];
    }
  }

  return { closed, open };
}

function checkLinearConsumption(handler: OnHandler, ownerVariant: string, diags: Diagnostic[]) {
  const label = `(${ownerVariant}, ${handler.message})`;
  const { closed, open } = walkBlock(handler.body, [{ consumeCount: 0, hasReject: false }]);

  if (open.length > 0) {
    diags.push({ message: `handler ${label}: must end with a return on every path`, pos: handler.pos });
  }

  for (const path of closed) {
    if (path.hasReject) {
      if (path.consumeCount !== 0) {
        diags.push({
          message: `handler ${label}: reject(...) path must not also consume(self) — a rejection returns the input state unchanged`,
          pos: path.pos,
        });
      }
    } else if (path.consumeCount === 0) {
      diags.push({
        message: `handler ${label}: state-transitioning path never calls consume(self) — value may be used twice or leaked`,
        pos: path.pos,
      });
    } else if (path.consumeCount > 1) {
      diags.push({
        message: `handler ${label}: consume(self) called ${path.consumeCount} times on one path — double-consumption`,
        pos: path.pos,
      });
    }
  }
}

export function typecheck(program: Program): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const sym = buildSymbolTable(program, diags);
  checkNameResolution(program, sym, diags);
  checkExhaustiveness(program, sym, diags);

  for (const d of program.decls) {
    if (d.kind === 'BehaviorDecl') {
      for (const h of d.handlers) {
        checkLinearConsumption(h, d.stateVariant, diags);
      }
    }
  }

  return diags;
}
