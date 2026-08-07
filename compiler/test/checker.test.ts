import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from '../src/frontend/parser';
import { typecheck } from '../src/typecheck/checker';

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures');

function messages(source: string): string[] {
  return typecheck(parse(source)).map(d => d.message);
}

test('counter fixture type-checks clean', () => {
  const source = fs.readFileSync(path.join(FIXTURES, 'counter.bunzou'), 'utf8');
  assert.deepEqual(typecheck(parse(source)), []);
});

test('counter-broken fixture reports the missing (Locked, Reset) transition', () => {
  const source = fs.readFileSync(path.join(FIXTURES, 'counter-broken.bunzou'), 'utf8');
  const diags = typecheck(parse(source));
  assert.equal(diags.length, 1);
  assert.equal(diags[0].message, 'Missing transition: (Locked, Reset)');
});

test('flags duplicate struct declarations', () => {
  const msgs = messages(`
    struct Foo { a: uint64 }
    struct Foo { b: uint64 }
  `);
  assert.ok(msgs.some(m => m === "duplicate struct 'Foo'"));
});

test('flags duplicate state declarations', () => {
  const msgs = messages(`
    state S { A }
    state S { B }
  `);
  assert.ok(msgs.some(m => m === "duplicate state 'S'"));
});

test('flags a state variant name reused across two state decls', () => {
  const msgs = messages(`
    state S1 { A }
    state S2 { A }
  `);
  assert.ok(msgs.some(m => m.includes("state variant 'A' declared in both")));
});

test('flags an unknown struct field type', () => {
  const msgs = messages(`
    struct Foo { a: Nonexistent }
  `);
  assert.ok(msgs.some(m => m === "struct 'Foo' field 'a': unknown type 'Nonexistent'"));
});

test('flags an unknown state variant payload type', () => {
  const msgs = messages(`
    state S { A(Nonexistent) }
  `);
  assert.ok(msgs.some(m => m === "state 'S' variant 'A': unknown payload type 'Nonexistent'"));
});

test('flags a behavior block for an undeclared state variant', () => {
  const msgs = messages(`
    behavior Ghost {
      on Ping(msg) -> Ghost { consume(self); return self; }
    }
  `);
  assert.ok(msgs.some(m => m.includes("undeclared state variant 'Ghost'")));
});

test('flags a handler returning an undeclared state variant', () => {
  const msgs = messages(`
    state S { A }
    behavior A {
      on Ping(msg) -> Nowhere { consume(self); return self; }
    }
  `);
  assert.ok(msgs.some(m => m.includes("returns undeclared state variant 'Nowhere'")));
});

test('flags a duplicate behavior block for the same variant', () => {
  const msgs = messages(`
    state S { A }
    behavior A { on Ping(msg) -> A { consume(self); return self; } }
    behavior A { on Ping(msg) -> A { consume(self); return self; } }
  `);
  assert.ok(msgs.some(m => m === "duplicate behavior block for state variant 'A'"));
});

test('flags a handler that never calls consume(self)', () => {
  const msgs = messages(`
    state S { A }
    behavior A { on Ping(msg) -> A { return self; } }
  `);
  assert.ok(msgs.some(m => m.includes('never calls consume(self)')));
});

test('flags a handler that calls consume(self) twice', () => {
  const msgs = messages(`
    state S { A }
    behavior A {
      on Ping(msg) -> A { consume(self); consume(self); return self; }
    }
  `);
  assert.ok(msgs.some(m => m.includes('double-consumption')));
});

test('flags reject(...) combined with consume(self) on the same path', () => {
  const msgs = messages(`
    state S { A }
    behavior A {
      on Ping(msg) -> A { reject("no"); consume(self); return self; }
    }
  `);
  assert.ok(msgs.some(m => m.includes('must not also consume(self)')));
});

test('flags a handler body that does not end with return', () => {
  const msgs = messages(`
    state S { A }
    behavior A { on Ping(msg) -> A { consume(self); } }
  `);
  assert.ok(msgs.some(m => m.includes('must end with a return on every path')));
});

test('a bare reject-and-return-self handler is accepted (dev guide: never a lesser form)', () => {
  const msgs = messages(`
    state S { A }
    behavior A { on Ping(msg) -> A { reject("not supported"); return self; } }
  `);
  assert.deepEqual(msgs, []);
});

// ---- Layer 1 over if/else: balanced consumption across branches ----

test('conditional-balanced fixture type-checks clean (consume in one branch, reject in the other)', () => {
  const source = fs.readFileSync(path.join(FIXTURES, 'conditional-balanced.bunzou'), 'utf8');
  assert.deepEqual(typecheck(parse(source)), []);
});

test('conditional-unbalanced fixture flags the branch that neither consumes nor rejects', () => {
  const source = fs.readFileSync(path.join(FIXTURES, 'conditional-unbalanced.bunzou'), 'utf8');
  const diags = typecheck(parse(source));
  assert.ok(diags.some(d => d.message.includes('never calls consume(self)')));
});

test('flags a then-branch that never consumes even when the else-branch is correct', () => {
  const msgs = messages(`
    state S { A }
    behavior A {
      on Ping(msg) -> A {
        if (msg.ok) {
          return self;
        } else {
          consume(self);
          return A;
        }
      }
    }
  `);
  assert.ok(msgs.some(m => m.includes('never calls consume(self)')));
});

test('flags double-consumption inside a single branch', () => {
  const msgs = messages(`
    state S { A }
    behavior A {
      on Ping(msg) -> A {
        if (msg.ok) {
          consume(self);
          consume(self);
          return A;
        } else {
          consume(self);
          return A;
        }
      }
    }
  `);
  assert.ok(msgs.some(m => m.includes('double-consumption')));
});

test('accepts both branches consuming self correctly (fully balanced if/else)', () => {
  const msgs = messages(`
    state S { A }
    behavior A {
      on Ping(msg) -> A {
        if (msg.ok) {
          consume(self);
          return A;
        } else {
          consume(self);
          return A;
        }
      }
    }
  `);
  assert.deepEqual(msgs, []);
});

test('an if with no else and no return after it is still "must end with a return on every path"', () => {
  const msgs = messages(`
    state S { A }
    behavior A {
      on Ping(msg) -> A {
        if (msg.ok) {
          consume(self);
          return A;
        }
      }
    }
  `);
  assert.ok(msgs.some(m => m.includes('must end with a return on every path')));
});

test('nested else-if chains are each checked as their own path', () => {
  const msgs = messages(`
    state S { A }
    behavior A {
      on Ping(msg) -> A {
        if (msg.a) {
          consume(self);
          return A;
        } else if (msg.b) {
          return A;
        } else {
          consume(self);
          return A;
        }
      }
    }
  `);
  assert.ok(msgs.some(m => m.includes('never calls consume(self)')));
});
