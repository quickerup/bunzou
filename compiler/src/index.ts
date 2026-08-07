import * as fs from 'fs';
import { parse, ParseError } from './frontend/parser';
import { LexError } from './frontend/lexer';
import { typecheck } from './typecheck/checker';

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: ts-node src/index.ts <file.bunzou>');
    process.exit(1);
  }
  const source = fs.readFileSync(file, 'utf8');

  try {
    const program = parse(source);
    const diags = typecheck(program);
    if (diags.length === 0) {
      console.log(`${file}: OK — parsed and type-checked (stage 1: lexer/parser + Layer 1 + Layer 4 only)`);
      process.exit(0);
    } else {
      console.log(`${file}: ${diags.length} error(s)`);
      for (const d of diags) {
        console.log(`  ${d.pos.line}:${d.pos.col}: ${d.message}`);
      }
      process.exit(1);
    }
  } catch (e) {
    if (e instanceof ParseError || e instanceof LexError) {
      console.log(`${file}: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main();
