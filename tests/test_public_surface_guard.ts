const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Running public-surface guard tests');

/**
 * Guards the `__test` seam convention:
 *  - a module may define `export const __test = { ... }` exactly once, and
 *  - nothing outside that definition may reference `__test`, so production
 *    code can never take a dependency on a test-only seam.
 */
const ROOT = process.cwd();
const SCAN_ROOTS = ['modules', 'market_adapter', 'analysis', 'scripts', 'claw'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', '.git']);
const SEAM_DEFINITION = /export const __test\s*=/;
const SEAM_TOKEN = /__test\b/g;

function collectTsFiles(dir: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            collectTsFiles(full, out);
            continue;
        }
        if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
    }
}

const files: string[] = [];
assert.ok(fs.existsSync(path.join(ROOT, 'modules')), 'run from the repo root (modules/ not found)');
for (const dir of SCAN_ROOTS) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) collectTsFiles(abs, files);
}
for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path.join(ROOT, entry.name));
}
assert.ok(files.length > 100, `expected to scan the source tree, found ${files.length} files`);

const violations: string[] = [];
let seamCount = 0;
for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const occurrences = (text.match(SEAM_TOKEN) || []).length;
    if (occurrences === 0) continue;

    const rel = path.relative(ROOT, file);
    if (!SEAM_DEFINITION.test(text)) {
        violations.push(`${rel}: references __test without defining a seam`);
        continue;
    }
    seamCount += 1;
    if (occurrences !== 1) {
        violations.push(`${rel}: seam is referenced ${occurrences} times (production code must not import __test)`);
    }
}

assert.deepStrictEqual(
    violations,
    [],
    `test seams must stay unused outside their defining module:\n  ${violations.join('\n  ')}`
);
assert.ok(seamCount > 0, 'expected at least one __test seam in the source tree');

console.log(`public-surface guard tests passed (${seamCount} seams, ${files.length} files scanned)`);
