import test from 'node:test';
import * as assert from 'node:assert/strict';
import { crc32 } from '../src/codegen/crc32';

test('crc32', () => {
    // Standard test vector
    assert.equal(crc32("123456789"), 0xCBF43926);
    // Test some op names
    const result = crc32("foo");
    assert.equal(typeof result, 'number');
    assert.equal(crc32("Increment"), 3615081709);
});
