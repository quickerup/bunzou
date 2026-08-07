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
// real handler bodies for the first time. Simplified for stage 1: no branching
// constructs exist in the grammar yet (see parser.ts), so "every path" reduces
// to "the handler's single straight-line body" — the balanced-branch case
// (spec Layer 1: "requires balanced consumption across if branches") is
// deliberately out of scope until the grammar grows conditionals.

function isCall(e: Expr, name: string): boolean {
  return e.kind === 'Call' && e.callee.kind === 'Ident' && e.callee.name === name;
}

function isConsumeSelf(e: Expr): boolean {
  return isCall(e, 'consume') && e.kind === 'Call' && e.args.length === 1 && e.args[0].kind === 'SelfExpr';
}

function checkLinearConsumption(handler: OnHandler, ownerVariant: string, diags: Diagnostic[]) {
  let consumeCount = 0;
  let hasReject = false;
  let lastIsReturn = false;

  handler.body.forEach((stmt: Stmt, idx: number) => {
    lastIsReturn = stmt.kind === 'ReturnStmt';
    if (stmt.kind === 'ExprStmt') {
      if (isConsumeSelf(stmt.expr)) consumeCount++;
      if (isCall(stmt.expr, 'reject')) hasReject = true;
    }
  });

  const label = `(${ownerVariant}, ${handler.message})`;

  if (!lastIsReturn) {
    diags.push({ message: `handler ${label}: must end with a return on every path`, pos: handler.pos });
  }

  if (hasReject) {
    if (consumeCount !== 0) {
      diags.push({
        message: `handler ${label}: reject(...) path must not also consume(self) — a rejection returns the input state unchanged`,
        pos: handler.pos,
      });
    }
  } else {
    if (consumeCount === 0) {
      diags.push({
        message: `handler ${label}: state-transitioning path never calls consume(self) — value may be used twice or leaked`,
        pos: handler.pos,
      });
    } else if (consumeCount > 1) {
      diags.push({
        message: `handler ${label}: consume(self) called ${consumeCount} times on one path — double-consumption`,
        pos: handler.pos,
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
