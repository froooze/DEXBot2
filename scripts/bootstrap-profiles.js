#!/usr/bin/env node
"use strict";

// Bootstrap profiles config files from tracked examples into profiles/
// Usage:
//   node scripts/bootstrap-profiles.js         # copies examples into profiles/ if files missing
//   node scripts/bootstrap-profiles.js --force # overwrite any existing profiles files
//   node scripts/bootstrap-profiles.js --dry   # dry-run, prints what would happen

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const dry = argv.includes('--dry') || argv.includes('--dry-run');

const repoRoot = path.join(__dirname, '..');
const examplesDir = path.join(repoRoot, 'examples');
const profilesDir = path.join(repoRoot, 'profiles');

function ensureProfilesDir() {
    if (!fs.existsSync(profilesDir)) {
        if (dry) {
            console.log('[dry] Would create:', profilesDir);
            return;
        }
        fs.mkdirSync(profilesDir, { recursive: true });
        console.log('Created profiles directory:', profilesDir);
    }
}

function isJsonFile(name) {
    return name.toLowerCase().endsWith('.json');
}

function copyExample(file) {
    const src = path.join(examplesDir, file);
    const dst = path.join(profilesDir, file);

    // Read/parse json to check it's valid
    try {
        const raw = fs.readFileSync(src, 'utf8');
        JSON.parse(raw);
    } catch (err) {
        console.error('ERROR: example is invalid JSON:', src, err.message);
        return;
    }

    if (fs.existsSync(dst) && !force) {
        console.log('Skipping existing:', dst, '(use --force to overwrite)');
        return;
    }

    if (dry) {
        console.log('[dry] Would copy', src, '->', dst);
        return;
    }

    fs.copyFileSync(src, dst);
    console.log('Copied', src, '->', dst);
}

function main() {
    if (!fs.existsSync(examplesDir)) {
        console.error('No examples directory found at', examplesDir);
        process.exit(1);
    }

    ensureProfilesDir();

    const items = fs.readdirSync(examplesDir);
    const jsonFiles = items.filter(isJsonFile);

    if (jsonFiles.length === 0) {
        console.log('No example JSON files found under examples/ to bootstrap.');
        return;
    }

    for (const f of jsonFiles) copyExample(f);

    console.log('\nBootstrap complete. Reminder: profiles/ is ignored by git; do NOT commit profiles secrets.');
}

main();
