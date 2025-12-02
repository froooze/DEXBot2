// Quick test: ensure the sanitization (\s removal) works for pasted multi-line private keys
const sample = `5KQwrPbwdL6PhXujxW37FSSQ3Q54\n\n\n\r\n 5JtUSf1k3\n3QX`;
console.log('Raw length:', sample.length);
const sanitized = sample.replace(/\s+/g, '');
console.log('Sanitized length:', sanitized.length);
console.log('Sanitized:', sanitized);
