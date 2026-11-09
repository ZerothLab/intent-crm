import test from 'node:test';
import assert from 'node:assert/strict';
import { amountToCents } from '../src/commercial/money.js';

test('yuan inputs retain exact cents without floating-point rounding', () => {
  assert.equal(amountToCents('0.29'),29);
  assert.equal(amountToCents('120000.01'),12_000_001);
  assert.equal(amountToCents(' 1.2 '),120);
  assert.equal(amountToCents('10000000000.00'),1_000_000_000_000);
});

test('financial writes reject ambiguous, rounded, zero and excessive input', () => {
  for(const value of ['', '0', '0.00', '-1', '1.001', '1,000', '1e3', 'Infinity', 'NaN', '01.50', '.5', '10000000000.01']) assert.throws(()=>amountToCents(value),Error,value);
});
