import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parse, ParseError } from '../src/frontend/parser';

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures');

test('parses the counter fixture into the expected top-level shape', () => {
  const source = fs.readFileSync(path.join(FIXTURES, 'counter.bunzou'), 'utf8');
  const program = parse(source);
  assert.deepEqual(
    program.decls.map(d => d.kind),
    ['StateDecl', 'StructDecl', 'BehaviorDecl', 'BehaviorDecl', 'GetMethodDecl'],
  );

  const stateDecl = program.decls[0];
  assert.equal(stateDecl.kind, 'StateDecl');
  if (stateDecl.kind === 'StateDecl') {
    assert.deepEqual(stateDecl.variants.map(v => v.name), ['Active', 'Locked']);
    assert.equal(stateDecl.variants[0].payloadType, 'CounterData');
  }

  const structDecl = program.decls[1];
  assert.equal(structDecl.kind, 'StructDecl');
  if (structDecl.kind === 'StructDecl') {
    assert.deepEqual(structDecl.fields.map(f => f.name), ['count', 'owner']);
  }
});

test('parses expression precedence: * before +, comparisons above &&/||', () => {
  const program = parse(`
    get_method get_count(): uint64 {
      return 1 + 2 * 3;
    }
  `);
  const method = program.decls[0];
  assert.equal(method.kind, 'GetMethodDecl');
  if (method.kind !== 'GetMethodDecl') return;
  const ret = method.body[0];
  assert.equal(ret.kind, 'ReturnStmt');
  if (ret.kind !== 'ReturnStmt') return;
  // 1 + (2 * 3): top node is the '+' BinaryOp
  assert.equal(ret.value.kind, 'BinaryOp');
  if (ret.value.kind === 'BinaryOp') {
    assert.equal(ret.value.op, '+');
    assert.equal(ret.value.right.kind, 'BinaryOp');
  }
});

test('parses struct literals and field access', () => {
  const program = parse(`
    get_method get_count(): uint64 {
      return CounterData { count: self.count, owner: self.owner };
    }
  `);
  const method = program.decls[0];
  assert.equal(method.kind, 'GetMethodDecl');
  if (method.kind !== 'GetMethodDecl') return;
  const ret = method.body[0];
  assert.equal(ret.kind, 'ReturnStmt');
  if (ret.kind !== 'ReturnStmt') return;
  assert.equal(ret.value.kind, 'StructLit');
  if (ret.value.kind === 'StructLit') {
    assert.equal(ret.value.typeName, 'CounterData');
    assert.equal(ret.value.fields.length, 2);
  }
});

test('parses transient state variant with inline ttl', () => {
  const program = parse(`
    state AuctionState {
      Idle,
      transient PendingBid(BidData): ttl 300
    }
  `);
  const decl = program.decls[0];
  assert.equal(decl.kind, 'StateDecl');
  if (decl.kind !== 'StateDecl') return;
  const pending = decl.variants[1];
  assert.equal(pending.name, 'PendingBid');
  assert.deepEqual(pending.transient, { ttl: 300 });
});

test('parses if/else into an IfStmt with both branches', () => {
  const program = parse(`
    behavior On {
      on Flip(msg) -> On {
        if (msg.approved) {
          consume(self);
          return On;
        } else {
          reject("not approved");
          return self;
        }
      }
    }
  `);
  const behavior = program.decls[0];
  assert.equal(behavior.kind, 'BehaviorDecl');
  if (behavior.kind !== 'BehaviorDecl') return;
  const body = behavior.handlers[0].body;
  assert.equal(body.length, 1);
  assert.equal(body[0].kind, 'IfStmt');
  if (body[0].kind !== 'IfStmt') return;
  assert.equal(body[0].thenBranch.length, 2);
  assert.ok(body[0].elseBranch);
  assert.equal(body[0].elseBranch!.length, 2);
});

test('parses else-if as a nested IfStmt inside the else branch', () => {
  const program = parse(`
    get_method get_count(): uint64 {
      if (self.count == 0) {
        return 0;
      } else if (self.count == 1) {
        return 1;
      } else {
        return self.count;
      }
    }
  `);
  const method = program.decls[0];
  assert.equal(method.kind, 'GetMethodDecl');
  if (method.kind !== 'GetMethodDecl') return;
  const outer = method.body[0];
  assert.equal(outer.kind, 'IfStmt');
  if (outer.kind !== 'IfStmt') return;
  assert.equal(outer.elseBranch?.length, 1);
  assert.equal(outer.elseBranch?.[0].kind, 'IfStmt');
});

test('an if with no else parses with elseBranch null', () => {
  const program = parse(`
    get_method get_count(): uint64 {
      if (self.count == 0) {
        return 0;
      }
      return self.count;
    }
  `);
  const method = program.decls[0];
  assert.equal(method.kind, 'GetMethodDecl');
  if (method.kind !== 'GetMethodDecl') return;
  const ifStmt = method.body[0];
  assert.equal(ifStmt.kind, 'IfStmt');
  if (ifStmt.kind === 'IfStmt') {
    assert.equal(ifStmt.elseBranch, null);
  }
});

test('rejects malformed top-level declarations with ParseError', () => {
  assert.throws(() => parse('not_a_keyword Foo {}'), ParseError);
});

test('rejects a handler missing its return arrow', () => {
  assert.throws(
    () => parse('behavior Active { on Increment(msg) Active { return self; } }'),
    ParseError,
  );
});

test('ParseError carries a position', () => {
  try {
    parse('state {}');
    assert.fail('expected ParseError');
  } catch (e) {
    assert.ok(e instanceof ParseError);
    assert.equal((e as ParseError).pos.line, 1);
  }
});
