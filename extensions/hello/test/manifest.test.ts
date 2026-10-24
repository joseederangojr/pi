import assert from 'node:assert/strict';
import test from 'node:test';

import { defineExtension } from '../src/index.ts';

test('defineExtension returns a manifest object', () => {
  assert.deepEqual(defineExtension('hello', './extension.ts'), {
    name: 'hello',
    entry: './extension.ts',
  });
});
