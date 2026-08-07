import { Position } from './ast';

export type TokenType =
  | 'KEYWORD'
  | 'IDENT'
  | 'NUMBER'
  | 'STRING'
  | 'PUNCT'
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  pos: Position;
}

const KEYWORDS = new Set([
  'state', 'struct', 'behavior', 'on', 'return', 'consume', 'require',
  'reject', 'get_method', 'self', 'true', 'false', 'transient',
  'if', 'else',
]);

// Multi-char punctuation must be checked longest-first.
const PUNCT_TOKENS = ['->', '==', '!=', '&&', '||', '<=', '>=',
  '{', '}', '(', ')', ',', ':', '.', ';', '=', '+', '-', '*', '/', '<', '>'];

export class LexError extends Error {
  constructor(message: string, public pos: Position) {
    super(`Lex error at ${pos.line}:${pos.col}: ${message}`);
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  function advance(n = 1) {
    for (let k = 0; k < n; k++) {
      if (source[i] === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  }

  while (i < source.length) {
    const ch = source[i];

    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }

    // line comments: // ...
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }

    const startPos: Position = { line, col };

    // string literal
    if (ch === '"') {
      let value = '';
      advance();
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          value += source[i + 1];
          advance(2);
        } else {
          value += source[i];
          advance();
        }
      }
      if (i >= source.length) throw new LexError('unterminated string literal', startPos);
      advance(); // closing quote
      tokens.push({ type: 'STRING', value, pos: startPos });
      continue;
    }

    // number literal
    if (/[0-9]/.test(ch)) {
      let value = '';
      while (i < source.length && /[0-9]/.test(source[i])) {
        value += source[i];
        advance();
      }
      tokens.push({ type: 'NUMBER', value, pos: startPos });
      continue;
    }

    // identifier / keyword
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
        value += source[i];
        advance();
      }
      tokens.push({ type: KEYWORDS.has(value) ? 'KEYWORD' : 'IDENT', value, pos: startPos });
      continue;
    }

    // punctuation (longest match first)
    const match = PUNCT_TOKENS.find(p => source.startsWith(p, i));
    if (match) {
      tokens.push({ type: 'PUNCT', value: match, pos: startPos });
      advance(match.length);
      continue;
    }

    throw new LexError(`unexpected character '${ch}'`, startPos);
  }

  tokens.push({ type: 'EOF', value: '', pos: { line, col } });
  return tokens;
}
