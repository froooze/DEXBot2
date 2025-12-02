#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const cfgPath = path.join(__dirname, '..', 'examples', 'bots.json');
const livePath = path.join(__dirname, '..', 'profiles', 'bots.json');

function stripComments(s) {
  return s.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').split('\n').map(l => l.replace(/(^|\s*)\/\/.*/, '')).join('\n');
}

function checkConfig(obj, src) {
  const bots = Array.isArray(obj.bots) && obj.bots.length ? obj.bots : [obj];
  console.log(`\n== Checking ${src}: found ${bots.length} bot entries`);
  const required = ['assetA', 'assetB', 'activeOrders', 'botFunds'];
  let anyMissing = false;

  bots.forEach((b, i) => {
    const name = b.name || `<unnamed-${i}>`;
    const missing = required.filter(k => !(k in b));
    if (missing.length) {
      anyMissing = true;
      console.warn(`- Bot[${i}] '${name}' is MISSING: ${missing.join(', ')}`);
    } else {
      console.log(`- Bot[${i}] '${name}' OK`);
    }
  });

  if (!anyMissing) console.log(`-> ${src}: all required fields present for every bot entry`);
}

// Validate tracked config (JSONC)
try {
  const rawCfg = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(stripComments(rawCfg));
  checkConfig(cfg, 'examples/bots.json (template, JSONC)');
} catch (err) {
  console.error('tracked config: parse error ->', err.message);
}

// Validate live config (JSON)
try {
  const rawLive = fs.readFileSync(livePath, 'utf8');
  const live = JSON.parse(rawLive);
  checkConfig(live, 'profiles/bots.json (live JSON)');
} catch (err) {
  console.error('live config: parse error ->', err.message);
}

// Exit code 0 (we only warn above)
process.exit(0);
