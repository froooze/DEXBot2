/**
 * tests/test_fill_pipeline_contract.ts
 *
 * The growth gate for the fill pipeline (docs/FILL_PIPELINE.md, P0).
 *
 * The fill path's bug family is not missing safeguards — it is the same
 * question answered in more than one place. This test pins the CURRENT
 * spelling of every such answer so that adding a fourth caller, a second
 * pivot writer, a third dedupe layer or a second fill-key implementation
 * fails the build instead of silently re-introducing the split.
 *
 * It is a RATCHET, not a spec:
 *   - these lists may SHRINK when a phase removes a duplicate,
 *   - they may only GROW by editing this file, which is the review.
 *
 * Baseline: `cb1041b6` (2026-11-04).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SCAN_ROOTS = ['modules'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', '.git']);

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
for (const dir of SCAN_ROOTS) collectTsFiles(path.join(ROOT, dir), files);
assert.ok(files.length > 100, `expected to scan the source tree, found ${files.length} files`);

const sources = new Map<string, string>();
for (const file of files) sources.set(path.relative(ROOT, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8'));

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
    try {
        assert.deepStrictEqual(actual, expected);
        console.log(`   ✓ ${name}`);
    } catch {
        failures += 1;
        console.error(`   ✗ ${name}\n      actual:   ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`);
    }
}

/** file -> occurrence count, for files that mention `token` at all. */
function countByFile(token: RegExp): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [rel, text] of sources) {
        const hits = (text.match(token) || []).length;
        if (hits > 0) out[rel] = hits;
    }
    return out;
}

/** Every file that has an ASSIGNMENT (not a read) to one of the named fields. */
function assignmentFiles(fields: string[]): string[] {
    const re = new RegExp(`\\b(${fields.join('|')})\\s*=[^=]`);
    const out: string[] = [];
    for (const [rel, text] of sources) if (re.test(text)) out.push(rel);
    return out.sort();
}

function testFillBatchCallSites() {
    console.log('\n[1] The batch processor has a pinned number of call sites');
    // 4 maintenance + 2 fill runtime + 4 startup call sites, plus the
    // definition (dexbot_class) and the interface declaration (types).
    check('call sites per file (no new adapter, no lost caller)', countByFile(/_processFillsWithBatching\(/g), {
        'modules/dexbot_maintenance_runtime.ts': 4,
        'modules/dexbot_fill_runtime.ts': 2,
        'modules/dexbot_startup_runtime.ts': 4,
        'modules/dexbot_class.ts': 1,
        'modules/types.ts': 1,
    });
}

function testPivotWriters() {
    console.log('\n[2] The LAST-FILL pivot has exactly two writers (the funnel + cold state)');
    check('assignment files', assignmentFiles(['_lastFilledPrice', '_lastFilledType', '_lastFilledAt', 'lastFillPivotSource']), [
        'modules/order/manager.ts',
        'modules/order/utils/system.ts',
    ]);
    check('no module outside the funnel sets a pivot scalar via a writable alias', (() => {
        const allowed = new Set(['modules/order/manager.ts', 'modules/order/utils/system.ts']);
        const offenders: string[] = [];
        for (const [rel, text] of sources) {
            if (allowed.has(rel)) continue;
            if (/(_lastFilledPrice|_lastFilledType|_lastFilledAt|lastFillPivotSource)\s*=[^=]/.test(text)) offenders.push(rel);
        }
        return offenders;
    })(), []);
}

function testBoundaryBudgets() {
    console.log('\n[3] Boundary budgets are still the two known manager fields');
    check('assignment files', assignmentFiles(['_boundaryReanchorBudget', '_boundaryShiftBudget', '_boundaryShiftBudgetBase']), [
        'modules/dexbot_class.ts',
        'modules/dexbot_cow_runtime.ts',
        'modules/order/strategy.ts',
    ]);
}

function testDedupeLayers() {
    console.log('\n[4] Dedupe layers are the known set (removal moves this list down)');
    // The surviving layers: the chain-size marker map, its per-fill amount
    // channel (`__chainSizeAppliedInt`), and the claim lease. The pre-P2
    // `alreadyAppliedChainSize` boolean is gone, and the OLD pattern missed
    // `accounting.ts` — the writer of the amount — entirely.
    const re = /_chainSizeAppliedFills|__chainSizeAppliedInt|_recentlyQueuedFills/g;
    check('files referencing a dedupe layer', Object.keys(countByFile(re)).sort(), [
        'modules/dexbot_class.ts',
        'modules/dexbot_fill_runtime.ts',
        'modules/dexbot_startup_runtime.ts',
        'modules/dexbot_state_recovery.ts',
        'modules/order/accounting.ts',
        'modules/order/grid.ts',
        'modules/order/lifecycle.ts',
        'modules/order/manager.ts',
        'modules/order/sync_engine.ts',
        'modules/types.ts',
    ]);
}

function testFillIdentityOwner() {
    console.log('\n[5] Fill identity and side resolution have one owner');
    check('fillKeyOf defined once', countByFile(/\bfunction fillKeyOf\b/g), {
        'modules/order/fill_ledger.ts': 1,
    });
    check('resolveTradedSide defined once', countByFile(/\bfunction resolveTradedSide\b/g), {
        'modules/order/fill_ledger.ts': 1,
    });
    check('no local buildFillKey definition remains', countByFile(/\bfunction buildFillKey\b/g), {});
    check('utils/order delegates through the ledger', /import \{ fillKeyOf, resolveTradedSide \} from '\.\.\/fill_ledger\.js'/.test(
        sources.get('modules/order/utils/order.ts') || ''
    ), true);
}

function testBlockerProjection() {
    console.log('\n[6] The blocker resolver composes; it does not add evidence');
    const system = sources.get('modules/order/utils/system.ts') || '';
    check('hasUnsettledFills is a projection over the fill-state codes', /fillStateBlockers\(readFillPipelineState\(source\)\)/.test(system), true);
    check('the fail-open catch is gone', /catch\s*(\(err\))?\s*\{\s*return \{ unsettled: false/.test(system), false);
    const codeUnion = system.slice(system.indexOf('export type GridUpdateBlockerCode'), system.indexOf('export interface GridUpdateBlocker'));
    check('the blocker code list is closed at eight codes', (codeUnion.match(/'[a-z-]+'/g) || []).length, 8);
    check('no declared code is unused (each one is produced)', (() => {
        const declared = (codeUnion.match(/'([a-z-]+)'/g) || []).map((c) => c.replace(/'/g, ''));
        return declared.filter((code) => !new RegExp(`code: '${code}'`).test(system));
    })(), []);
    check('escalation is a cycle counter, not a timing window', (() => {
        const constants = sources.get('modules/constants.ts') || '';
        return /GRID_BLOCKED_ESCALATE_CYCLES/.test(constants);
    })(), true);
}

function run() {
    console.log('Fill pipeline contract (ratchet) tests');
    testFillBatchCallSites();
    testPivotWriters();
    testBoundaryBudgets();
    testDedupeLayers();
    testFillIdentityOwner();
    testBlockerProjection();
    if (failures > 0) {
        console.error(`\n❌ ${failures} fill-pipeline contract assertion(s) failed`);
        console.error('   A new caller/writer/duplicate appeared. Edit this ratchet deliberately or remove the duplicate.');
        process.exit(1);
    }
    console.log('\n✅ Fill pipeline contract holds');
}

run();
