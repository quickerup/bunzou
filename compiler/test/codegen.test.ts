import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from '../src/frontend/parser';
import { compileProgram } from '../src/codegen';

test('codegen compiles counter fixture to BOC', async () => {
    const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'counter.bunzou');
    const source = fs.readFileSync(fixturePath, 'utf-8');
    const program = parse(source);
    
    const result = await compileProgram(program);
    assert.ok(result.boc.length > 0);
});
