import test from 'node:test';
import * as assert from 'node:assert/strict';
import { crc32 } from '../src/codegen/crc32';

test('crc32', () => {
    // Standard test vector
    assert.equal(crc32("123456789"), 0xCBF43926);
    // Test some op names
    // op::foo = crc32("foo")
    assert.equal(typeof crc32("foo"), 'number');
});
