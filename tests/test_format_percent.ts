/**
 * tests/test_format_percent.ts
 *
 * Regression coverage for `formatPercentLabel` (modules/order/format.ts), the
 * shared percentage renderer used by the liquidity depth chart, its analyzer and
 * anything else that prints a percentage with its unit.
 *
 * Why it exists: `formatCurrency` drops into SI suffixes below 0.1, so a 0.05%
 * spread rendered as "50m%", and every caller had to remember the decimal count.
 * The label formatter owns the precision rule: 2 decimals below 100%, 1 from
 * 100%, 0 from 1000% — at most four significant digits, easy to reason about.
 */

const assert = require('assert');
const { formatPercentLabel, formatPercent, formatPercent2 } = require('../modules/order/format');

console.log('Testing formatPercentLabel...\n');

// Below 100%: exactly 2 decimals (spreads, fees, single- and double-digit values).
assert.strictEqual(formatPercentLabel(18.18), '18.18%');
assert.strictEqual(formatPercentLabel(2.2664), '2.27%');
assert.strictEqual(formatPercentLabel(0.4), '0.40%');
assert.strictEqual(formatPercentLabel(0.5), '0.50%');
assert.strictEqual(formatPercentLabel(0.05), '0.05%');
assert.strictEqual(formatPercentLabel(9.999), '10.00%');

// 100% and above: one decimal, then none — still four significant digits.
assert.strictEqual(formatPercentLabel(100), '100.0%');
assert.strictEqual(formatPercentLabel(999.94), '999.9%');
assert.strictEqual(formatPercentLabel(1234.5), '1235%');

// Never SI-suffixed: the old path rendered 0.05 as "50m".
assert.ok(!/m%|µ%|n%/.test(formatPercentLabel(0.05)));

// Zero and absent/invalid input.
assert.strictEqual(formatPercentLabel(0), '0.00%');
assert.strictEqual(formatPercentLabel(null), 'N/A');
assert.strictEqual(formatPercentLabel(undefined), 'N/A');
assert.strictEqual(formatPercentLabel(Number.NaN), 'N/A');
assert.strictEqual(formatPercentLabel(Number.POSITIVE_INFINITY as any), 'N/A');
assert.strictEqual(formatPercentLabel('12' as any), 'N/A');

// The bare-number contracts are unchanged (callers append their own unit).
assert.strictEqual(formatPercent(0.9975, 3), '0.998');
assert.strictEqual(formatPercent2(0.9975), '1.00');

console.log('All formatPercentLabel assertions passed.');
