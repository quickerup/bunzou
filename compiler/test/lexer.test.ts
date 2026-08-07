import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, LexError } from '../src/frontend/lexer';

test('tokenizes keywords, idents, punctuation', () => {
  const tokens = tokenize('state Foo { bar: uint64 }');
  const shapes = tokens.map(t => [t.type, t.value]);
  assert.deepEqual(shapes, [
    ['KEYWORD', 'state'],
    ['IDENT', 'Foo'],
    ['PUNCT', '{'],
    ['IDENT', 'bar'],
    ['PUNCT', ':'],
    ['IDENT', 'uint64'],
    ['PUNCT', '}'],
    ['EOF', ''],
  ]);
});

test('tokenizes number and string literals', () => {
  const tokens = tokenize('42 "hello \\"world\\""');
  assert.equal(tokens[0].type, 'NUMBER');
  assert.equal(tokens[0].value, '42');
  assert.equal(tokens[1].type, 'STRING');
  assert.equal(tokens[1].value, 'hello "world"');
});

test('skips line comments', () => {
  const tokens = tokenize('// a comment\nstate');
  assert.deepEqual(tokens.map(t => t.type), ['KEYWORD', 'EOF']);
});

test('multi-char punctuation is matched longest-first', () => {
  const tokens = tokenize('-> == != && || <= >=');
  assert.deepEqual(tokens.map(t => t.value), ['->', '==', '!=', '&&', '||', '<=', '>=', '']);
});

test('tracks line/col across newlines', () => {
  const tokens = tokenize('a\nbb');
  assert.deepEqual(tokens[0].pos, { line: 1, col: 1 });
  assert.deepEqual(tokens[1].pos, { line: 2, col: 1 });
});

test('throws LexError on unexpected character', () => {
  assert.throws(() => tokenize('@'), LexError);
});

test('throws LexError on unterminated string', () => {
  assert.throws(() => tokenize('"unterminated'), LexError);
});
