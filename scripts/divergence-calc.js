const fs = require('fs');
const path = require('path');

// Read data from file argument or stdin
function readData() {
  const args = process.argv.slice(2);

  if (args.length > 0 && args[0] !== '-') {
    // Read from file if argument provided
    const filePath = path.resolve(args[0]);
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.error(`Error reading file "${filePath}":`, err.message);
      process.exit(1);
    }
  }

  // Otherwise read from stdin
  return fs.readFileSync(0, 'utf-8');
}

const data = readData();

const lines = data.trim().split('\n');
const orders = [];

lines.forEach(line => {
  // Parse orders in format: Buy/Sell order-id @ price: persisted → calculated [state]
  // State is optional and used to exclude partial orders
  const match = line.match(/(?:Buy|Sell) (?:buy|sell)-(\d+) @ ([\d.]+): ([\d.]+) → ([\d.]+)(?:\s+\[(\w+)\])?/);
  if (match) {
    const orderId = match[1];
    const price = parseFloat(match[2]);
    const persisted = parseFloat(match[3]);   // First value is persisted (old)
    const calculated = parseFloat(match[4]);  // Second value is calculated (new)
    const state = match[5] || 'active';       // Default to 'active' if no state specified
    orders.push({ orderId, price, calculated, persisted, state });
  }
});

// Filter out partial orders from divergence calculation
// Include: 'active' and 'virtual' orders - these represent the intended grid structure
// Exclude: 'partial' orders - these are temporarily filled and in transition
const activeOrders = orders.filter(o => o.state !== 'partial');
const partialOrdersCount = orders.length - activeOrders.length;

// Calculate divergence metric: sum of ((calculated - persisted) / persisted)^2 / count
let sumSquaredDiff = 0;
activeOrders.forEach(order => {
  const relativeError = (order.calculated - order.persisted) / order.persisted;
  sumSquaredDiff += relativeError * relativeError;
});

const normalizedMetric = activeOrders.length > 0 ? sumSquaredDiff / activeOrders.length : 0;
const promille = normalizedMetric * 1000;

// Calculate real error as √(promille / 1000)
const realErrorPercent = Math.sqrt(promille / 1000) * 100;

console.log('=== QUADRATIC DIVERGENCE ANALYSIS ===\n');
console.log(`Total orders in input: ${orders.length}`);
console.log(`Orders analyzed: ${activeOrders.length}`);
if (partialOrdersCount > 0) {
  console.log(`Partial orders excluded: ${partialOrdersCount}`);
}
console.log(`Sum of squared relative differences: ${sumSquaredDiff.toFixed(8)}`);
console.log(`\nMetric: ${normalizedMetric.toFixed(8)}`);
console.log(`In promille: ${promille.toFixed(4)}`);
console.log(`Real average error: ${realErrorPercent.toFixed(2)}%`);
console.log(`\nThreshold comparison (from constants.js):`);
console.log(`  Current: ${promille.toFixed(4)} promille`);
console.log(`  Default threshold: 1 promille (3.2% avg error)`);
console.log(`  Status: ${promille <= 1 ? '✓ WITHIN THRESHOLD' : '✗ EXCEEDS THRESHOLD'}`);

// Show min/max errors
let minError = Infinity, maxError = -Infinity;
let minErrorOrder = null, maxErrorOrder = null;
activeOrders.forEach((order, idx) => {
  const absError = Math.abs((order.calculated - order.persisted) / order.persisted);
  if (absError < minError) { minError = absError; minErrorOrder = { ...order, idx }; }
  if (absError > maxError) { maxError = absError; maxErrorOrder = { ...order, idx }; }
});

console.log(`\nMin error: ${(minError * 100).toFixed(4)}% at buy-${minErrorOrder.idx}`);
console.log(`  Calculated: ${minErrorOrder.calculated.toFixed(8)}, Persisted: ${minErrorOrder.persisted.toFixed(8)}`);
console.log(`Max error: ${(maxError * 100).toFixed(4)}% at buy-${maxErrorOrder.idx}`);
console.log(`  Calculated: ${maxErrorOrder.calculated.toFixed(8)}, Persisted: ${maxErrorOrder.persisted.toFixed(8)}`);
