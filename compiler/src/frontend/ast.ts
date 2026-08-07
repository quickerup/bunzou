// AST for stage 1 (lexer/parser + type checker). Covers exactly the surface
// syntax the spec demonstrates as working (spec §5, the counter contract) and
// the guide's terminology (state / struct / behavior / on / consume / return
// / require / reject / get_method). `transient` + `ttl` are parsed (dev guide
// §2 says every transient state needs a ttl) but their downstream semantics
// (Layer 5 pending-map lowering) are explicitly unformalized per spec §6 —
// treat TransientInfo as a parsed placeholder, not a checked construct yet.

export interface Position {
  line: number;
  col: number;
}

export interface StateVariant {
  name: string;
  payloadType: string | null; // e.g. "CounterData" in Active(CounterData)
  transient: TransientInfo | null;
  pos: Position;
}

export interface TransientInfo {
  ttl: number | null; // null if declared `transient` with no ttl literal given
}

export interface StateDecl {
  kind: 'StateDecl';
  name: string;
  variants: StateVariant[];
  pos: Position;
}

export interface StructField {
  name: string;
  type: string;
  pos: Position;
}

export interface StructDecl {
  kind: 'StructDecl';
  name: string;
  fields: StructField[];
  pos: Position;
}

export type Stmt = ExprStmt | ReturnStmt;

export interface ExprStmt {
  kind: 'ExprStmt';
  expr: Expr;
  pos: Position;
}

export interface ReturnStmt {
  kind: 'ReturnStmt';
  value: Expr;
  pos: Position;
}

export type Expr =
  | Ident
  | SelfExpr
  | FieldAccess
  | Call
  | BinaryOp
  | StructLit
  | NumberLit
  | StringLit
  | BoolLit;

export interface Ident {
  kind: 'Ident';
  name: string;
  pos: Position;
}

export interface SelfExpr {
  kind: 'SelfExpr';
  pos: Position;
}

export interface FieldAccess {
  kind: 'FieldAccess';
  object: Expr;
  field: string;
  pos: Position;
}

export interface Call {
  kind: 'Call';
  callee: Expr; // Ident (function/constructor) or FieldAccess (method-ish)
  args: Expr[];
  pos: Position;
}

export interface BinaryOp {
  kind: 'BinaryOp';
  op: string;
  left: Expr;
  right: Expr;
  pos: Position;
}

export interface StructLit {
  kind: 'StructLit';
  typeName: string;
  fields: { name: string; value: Expr }[];
  pos: Position;
}

export interface NumberLit {
  kind: 'NumberLit';
  value: number;
  pos: Position;
}

export interface StringLit {
  kind: 'StringLit';
  value: string;
  pos: Position;
}

export interface BoolLit {
  kind: 'BoolLit';
  value: boolean;
  pos: Position;
}

export interface OnHandler {
  kind: 'OnHandler';
  message: string;
  paramName: string; // e.g. `msg` in `on Increment(msg) -> Active`
  returnType: string; // must name a State variant
  body: Stmt[];
  pos: Position;
}

export interface BehaviorDecl {
  kind: 'BehaviorDecl';
  stateVariant: string; // which State variant this behavior block is for
  handlers: OnHandler[];
  pos: Position;
}

export interface GetMethodDecl {
  kind: 'GetMethodDecl';
  name: string;
  returnType: string;
  body: Stmt[];
  pos: Position;
}

export type TopDecl = StateDecl | StructDecl | BehaviorDecl | GetMethodDecl;

export interface Program {
  kind: 'Program';
  decls: TopDecl[];
}
