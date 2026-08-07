import { Token, tokenize } from '../frontend/lexer';
import {
  Program, TopDecl, StateDecl, StateVariant, StructDecl, StructField,
  BehaviorDecl, OnHandler, GetMethodDecl, Stmt, Expr, Position,
} from '../frontend/ast';

export class ParseError extends Error {
  constructor(message: string, public pos: Position) {
    super(`Parse error at ${pos.line}:${pos.col}: ${message}`);
  }
}

export function parse(source: string): Program {
  const tokens = tokenize(source);
  let pos = 0;

  function peek(offset = 0): Token {
    return tokens[Math.min(pos + offset, tokens.length - 1)];
  }

  function at(type: string, value?: string): boolean {
    const t = peek();
    if (t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }

  function next(): Token {
    const t = tokens[pos];
    if (pos < tokens.length - 1) pos++;
    return t;
  }

  function expect(type: string, value?: string): Token {
    if (!at(type, value)) {
      const t = peek();
      throw new ParseError(
        `expected ${value ?? type}, got ${t.type === 'EOF' ? 'EOF' : `'${t.value}'`}`,
        t.pos,
      );
    }
    return next();
  }

  function expectIdent(): Token {
    return expect('IDENT');
  }

  // ---- top level ----

  function parseProgram(): Program {
    const decls: TopDecl[] = [];
    while (!at('EOF')) {
      decls.push(parseTopDecl());
    }
    return { kind: 'Program', decls };
  }

  function parseTopDecl(): TopDecl {
    if (at('KEYWORD', 'state')) return parseStateDecl();
    if (at('KEYWORD', 'struct')) return parseStructDecl();
    if (at('KEYWORD', 'behavior')) return parseBehaviorDecl();
    if (at('KEYWORD', 'get_method')) return parseGetMethodDecl();
    const t = peek();
    throw new ParseError(
      `expected 'state', 'struct', 'behavior', or 'get_method', got '${t.value}'`,
      t.pos,
    );
  }

  // state CounterState { Active(CounterData), Locked(CounterData) }
  // A variant may be prefixed `transient` and carry `ttl: <number>` — this
  // syntax is proposed, not spec-confirmed (spec §6: transient/ttl surface
  // syntax was never reconciled into one grammar).
  function parseStateDecl(): StateDecl {
    const startPos = expect('KEYWORD', 'state').pos;
    const name = expectIdent().value;
    expect('PUNCT', '{');
    const variants: StateVariant[] = [];
    while (!at('PUNCT', '}')) {
      variants.push(parseStateVariant());
      if (at('PUNCT', ',')) next();
    }
    expect('PUNCT', '}');
    return { kind: 'StateDecl', name, variants, pos: startPos };
  }

  function parseStateVariant(): StateVariant {
    let transient = null as StateVariant['transient'];
    if (at('KEYWORD', 'transient')) {
      next();
      transient = { ttl: null };
    }
    const vPos = peek().pos;
    const name = expectIdent().value;
    let payloadType: string | null = null;
    if (at('PUNCT', '(')) {
      next();
      payloadType = expectIdent().value;
      expect('PUNCT', ')');
    }
    if (transient && at('PUNCT', ':')) {
      // proposed inline form: transient PendingX(Data): ttl 300
      next();
      const kw = expectIdent();
      if (kw.value !== 'ttl') {
        throw new ParseError(`expected 'ttl' after ':' on transient variant`, kw.pos);
      }
      const n = expect('NUMBER');
      transient = { ttl: parseInt(n.value, 10) };
    }
    return { name, payloadType, transient, pos: vPos };
  }

  // struct CounterData { count: uint64, owner: addr }
  function parseStructDecl(): StructDecl {
    const startPos = expect('KEYWORD', 'struct').pos;
    const name = expectIdent().value;
    expect('PUNCT', '{');
    const fields: StructField[] = [];
    while (!at('PUNCT', '}')) {
      const fPos = peek().pos;
      const fname = expectIdent().value;
      expect('PUNCT', ':');
      const ftype = expectIdent().value;
      fields.push({ name: fname, type: ftype, pos: fPos });
      if (at('PUNCT', ',')) next();
    }
    expect('PUNCT', '}');
    return { kind: 'StructDecl', name, fields, pos: startPos };
  }

  // behavior Active { on Increment(msg) -> Active { ... } ... }
  function parseBehaviorDecl(): BehaviorDecl {
    const startPos = expect('KEYWORD', 'behavior').pos;
    const stateVariant = expectIdent().value;
    expect('PUNCT', '{');
    const handlers: OnHandler[] = [];
    while (!at('PUNCT', '}')) {
      handlers.push(parseOnHandler());
    }
    expect('PUNCT', '}');
    return { kind: 'BehaviorDecl', stateVariant, handlers, pos: startPos };
  }

  function parseOnHandler(): OnHandler {
    const startPos = expect('KEYWORD', 'on').pos;
    const message = expectIdent().value;
    expect('PUNCT', '(');
    const paramName = expectIdent().value;
    expect('PUNCT', ')');
    expect('PUNCT', '->');
    const returnType = expectIdent().value;
    const body = parseBlock();
    return { kind: 'OnHandler', message, paramName, returnType, body, pos: startPos };
  }

  // get_method get_count(): uint64 { return self.count; }
  function parseGetMethodDecl(): GetMethodDecl {
    const startPos = expect('KEYWORD', 'get_method').pos;
    const name = expectIdent().value;
    expect('PUNCT', '(');
    expect('PUNCT', ')');
    expect('PUNCT', ':');
    const returnType = expectIdent().value;
    const body = parseBlock();
    return { kind: 'GetMethodDecl', name, returnType, body, pos: startPos };
  }

  function parseBlock(): Stmt[] {
    expect('PUNCT', '{');
    const stmts: Stmt[] = [];
    while (!at('PUNCT', '}')) {
      stmts.push(parseStmt());
    }
    expect('PUNCT', '}');
    return stmts;
  }

  function parseStmt(): Stmt {
    if (at('KEYWORD', 'return')) {
      const p = next().pos;
      const value = parseExpr();
      expect('PUNCT', ';');
      return { kind: 'ReturnStmt', value, pos: p };
    }
    const p = peek().pos;
    const expr = parseExpr();
    expect('PUNCT', ';');
    return { kind: 'ExprStmt', expr, pos: p };
  }

  // ---- expressions (precedence climbing) ----
  // primary -> postfix (call / field access) -> * / -> + - -> comparisons -> && -> ||

  function parseExpr(): Expr {
    return parseOr();
  }

  function parseOr(): Expr {
    let left = parseAnd();
    while (at('PUNCT', '||')) {
      const p = next().pos;
      left = { kind: 'BinaryOp', op: '||', left, right: parseAnd(), pos: p };
    }
    return left;
  }

  function parseAnd(): Expr {
    let left = parseEquality();
    while (at('PUNCT', '&&')) {
      const p = next().pos;
      left = { kind: 'BinaryOp', op: '&&', left, right: parseEquality(), pos: p };
    }
    return left;
  }

  function parseEquality(): Expr {
    let left = parseAdditive();
    while (at('PUNCT', '==') || at('PUNCT', '!=')) {
      const opTok = next();
      left = { kind: 'BinaryOp', op: opTok.value, left, right: parseAdditive(), pos: opTok.pos };
    }
    return left;
  }

  function parseAdditive(): Expr {
    let left = parseMultiplicative();
    while (at('PUNCT', '+') || at('PUNCT', '-')) {
      const opTok = next();
      left = { kind: 'BinaryOp', op: opTok.value, left, right: parseMultiplicative(), pos: opTok.pos };
    }
    return left;
  }

  function parseMultiplicative(): Expr {
    let left = parsePostfix();
    while (at('PUNCT', '*') || at('PUNCT', '/')) {
      const opTok = next();
      left = { kind: 'BinaryOp', op: opTok.value, left, right: parsePostfix(), pos: opTok.pos };
    }
    return left;
  }

  function parsePostfix(): Expr {
    let expr = parsePrimary();
    for (;;) {
      if (at('PUNCT', '.')) {
        const p = next().pos;
        const field = expectIdent().value;
        expr = { kind: 'FieldAccess', object: expr, field, pos: p };
      } else if (at('PUNCT', '(')) {
        const p = next().pos;
        const args: Expr[] = [];
        while (!at('PUNCT', ')')) {
          args.push(parseExpr());
          if (at('PUNCT', ',')) next();
        }
        expect('PUNCT', ')');
        expr = { kind: 'Call', callee: expr, args, pos: p };
      } else if (at('PUNCT', '{') && (expr.kind === 'Ident')) {
        // struct literal: TypeName { field: expr, ... }
        expr = parseStructLitTail(expr.name, expr.pos);
      } else {
        break;
      }
    }
    return expr;
  }

  function parseStructLitTail(typeName: string, p: Position): Expr {
    expect('PUNCT', '{');
    const fields: { name: string; value: Expr }[] = [];
    while (!at('PUNCT', '}')) {
      const fname = expectIdent().value;
      expect('PUNCT', ':');
      const value = parseExpr();
      fields.push({ name: fname, value });
      if (at('PUNCT', ',')) next();
    }
    expect('PUNCT', '}');
    return { kind: 'StructLit', typeName, fields, pos: p };
  }

  function parsePrimary(): Expr {
    const t = peek();
    if (t.type === 'NUMBER') {
      next();
      return { kind: 'NumberLit', value: parseInt(t.value, 10), pos: t.pos };
    }
    if (t.type === 'STRING') {
      next();
      return { kind: 'StringLit', value: t.value, pos: t.pos };
    }
    if (at('KEYWORD', 'true') || at('KEYWORD', 'false')) {
      next();
      return { kind: 'BoolLit', value: t.value === 'true', pos: t.pos };
    }
    if (at('KEYWORD', 'self')) {
      next();
      return { kind: 'SelfExpr', pos: t.pos };
    }
    if (t.type === 'IDENT') {
      next();
      return { kind: 'Ident', name: t.value, pos: t.pos };
    }
    if (at('KEYWORD', 'consume') || at('KEYWORD', 'require') || at('KEYWORD', 'reject')) {
      // reserved words, but only ever appear as call targets: consume(self), etc.
      next();
      return { kind: 'Ident', name: t.value, pos: t.pos };
    }
    if (at('PUNCT', '(')) {
      next();
      const e = parseExpr();
      expect('PUNCT', ')');
      return e;
    }
    throw new ParseError(`unexpected token '${t.value || t.type}'`, t.pos);
  }

  return parseProgram();
}
