const data = ``;

const lines = data.trim().split('\n');
const orders = [];

lines.forEach(line => {
  const match = line.match(/Buy buy-\d+ @ ([\d.]+): ([\d.]+) → ([\d.]+)/);
  if (match) {
    const price = parseFloat(match[1]);
    const calculated = parseFloat(match[2]);
    const persisted = parseFloat(match[3]);
    orders.push({ price, calculated, persisted });
  }
});

// Calculate divergence metric: sum of ((calculated - persisted) / persisted)^2 / count
let sumSquaredDiff = 0;
orders.forEach(order => {
  const relativeError = (order.calculated - order.persisted) / order.persisted;
  sumSquaredDiff += relativeError * relativeError;
});

const normalizedMetric = sumSquaredDiff / orders.length;
const promille = normalizedMetric * 1000;

// Calculate real error as √(promille / 1000)
const realErrorPercent = Math.sqrt(promille / 1000) * 100;

console.log('=== QUADRATIC DIVERGENCE ANALYSIS ===\n');
console.log(`Orders analyzed: ${orders.length}`);
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
orders.forEach((order, idx) => {
  const absError = Math.abs((order.calculated - order.persisted) / order.persisted);
  if (absError < minError) { minError = absError; minErrorOrder = { ...order, idx }; }
  if (absError > maxError) { maxError = absError; maxErrorOrder = { ...order, idx }; }
});

console.log(`\nMin error: ${(minError * 100).toFixed(4)}% at buy-${minErrorOrder.idx}`);
console.log(`  Calculated: ${minErrorOrder.calculated.toFixed(8)}, Persisted: ${minErrorOrder.persisted.toFixed(8)}`);
console.log(`Max error: ${(maxError * 100).toFixed(4)}% at buy-${maxErrorOrder.idx}`);
console.log(`  Calculated: ${maxErrorOrder.calculated.toFixed(8)}, Persisted: ${maxErrorOrder.persisted.toFixed(8)}`);
