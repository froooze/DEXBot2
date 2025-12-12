const assert = require('assert');
const fs = require('fs');
console.log('Running templates ordering tests');

function containsSellFirst(filePath, keyName) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Note: in JS string literals, `\s` must be escaped as `\\s` to reach RegExp.
  const re = new RegExp(`"${keyName}"\\s*:\\s*\\{\\s*"sell"`, 'i');
  return re.test(raw);
}

assert(containsSellFirst('examples/bots.json', 'botFunds'), 'examples/bots.json should list sell before buy for botFunds');
assert(containsSellFirst('examples/bots.json', 'activeOrders'), 'examples/bots.json should list sell before buy for activeOrders');
assert(containsSellFirst('profiles/bots.json', 'botFunds'), 'profiles/bots.json should list sell before buy for botFunds');
assert(containsSellFirst('profiles/bots.json', 'activeOrders'), 'profiles/bots.json should list sell before buy for activeOrders');

console.log('templates ordering tests passed');
