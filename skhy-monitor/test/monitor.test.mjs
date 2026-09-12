import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePremium,
  calculateSuggestedQuote,
  fillBaseQuantity,
  fillGateContracts,
  normalizeGateBook,
  normalizeKrakenBook,
} from '../src/monitor.mjs';

test('normalizes and sorts both official-style order books', () => {
  const kraken = normalizeKrakenBook({
    result: 'success',
    orderBook: { bids: [[189, 1], [190, 2]], asks: [[191, 3], [190.5, 1]] },
  });
  const gate = normalizeGateBook({
    bids: [{ p: '1364', s: 10 }, { p: '1365', s: 10 }],
    asks: [{ p: '1366', s: 10 }, { p: '1365', s: 10 }],
  });
  assert.deepEqual(kraken.bids.map((row) => row.price), [190, 189]);
  assert.deepEqual(kraken.asks.map((row) => row.price), [190.5, 191]);
  assert.deepEqual(gate.bids.map((row) => row.price), [1365, 1364]);
  assert.deepEqual(gate.asks.map((row) => row.price), [1365, 1366]);
});

test('computes weighted fills and Gate contract quantities', () => {
  const kraken = fillBaseQuantity([{ price: 190, size: 1 }, { price: 189, size: 2 }], 2);
  const gate = fillGateContracts([{ price: 1365, size: 1000 }], 2, 0.001);
  assert.equal(kraken.vwap, 189.5);
  assert.equal(kraken.notional, 379);
  assert.equal(gate.assetQuantity, 0.002);
  assert.equal(gate.notional, 2.73);
});

test('suggests a CrossEx per-order quantity with small notional mismatch', () => {
  const quote = calculateSuggestedQuote({
    targetNotionalUsd: 6000,
    adrRatio: 10,
    krakenLevels: [{ price: 190, size: 100 }],
    gateLevels: [{ price: 1365, size: 100000 }],
    gateMultiplier: 0.001,
    minimumGateContracts: 1,
  });
  assert.ok(Math.abs(quote.kraken.notional - 6000) < 10);
  assert.ok(quote.imbalancePct < 1);
  assert.ok(quote.quantity > 31 && quote.quantity < 32);
  assert.ok(quote.gate.filledContracts > 4000);
  assert.equal(quote.premiumPct, calculatePremium({
    krakenPrice: quote.kraken.vwap,
    gatePrice: quote.gate.vwap,
    adrRatio: 10,
  }));
});
