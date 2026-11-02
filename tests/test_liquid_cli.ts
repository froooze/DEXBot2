const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running liquid cli tests');

// `dexbot liquid` (scripts/liquid.ts) resolves a bot/pair target and forwards
// the liquidity options to analysis/analyze_liquidity.js. These tests cover
// parsing/normalization and the offline entry-point behavior (help / missing
// target / bad flag must not touch the network).

const { parseArgs, resolveTarget } = require('../scripts/liquid');
require('../scripts/liquid'); // entry must load WITHOUT auto-invoking the pipeline

const LIQUID_SCRIPT = path.join(__dirname, '..', 'scripts', 'liquid.js');

function testParseArgsForwardsOptions() {
    const parsed = parseArgs(['TOKENA/TOKENB', '--range', '0.3', '--depth', '100', '--steps', '250', '--pool', '1.19.123', '--chart', 'out.html', '--json', 'dump.json', '--quiet']);
    assert.strictEqual(parsed.target, 'TOKENA/TOKENB');
    assert.deepStrictEqual(parsed.analyzerArgs, [
        '--range', '0.3', '--depth', '100', '--steps', '250', '--pool', '1.19.123', '--chart', 'out.html', '--json', 'dump.json', '--quiet',
    ]);
    assert.strictEqual(parsed.help, false);
    assert.strictEqual(parseArgs(['--help']).help, true);
}

function testParseArgsRejectsBadInput() {
    assert.throws(() => parseArgs(['--bogus']), /Unknown flag "--bogus"\. Usage: dexbot liquid /);
    assert.throws(() => parseArgs(['A/B', 'extra']), /Only one target is supported\. Usage: dexbot liquid /);
    assert.throws(() => parseArgs(['A/B', '--range']), /--range expects a value/);
    assert.throws(() => parseArgs(['A/B', '--range', '--depth', '5']), /--range expects a value/);
}

function testResolvePairNormalizesCase() {
    const pair = resolveTarget('tokena/tokenb');
    assert.strictEqual(pair.base, 'TOKENA');
    assert.strictEqual(pair.quote, 'TOKENB');
    assert.throws(() => resolveTarget('A/B/C'), /Invalid pair "A\/B\/C"\. Use AssetA\/AssetB/);
}

function script(argv) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [LIQUID_SCRIPT, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('liquid.js timed out')); }, 30000);
        child.stdout.on('data', (d) => { stdout += String(d); });
        child.stderr.on('data', (d) => { stderr += String(d); });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

async function testHelpPrintsLiquidUsageOffline() {
    const res = await script(['--help']);
    assert.strictEqual(res.status, 0, `--help should exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /Usage: dexbot liquid /);
    assert.match(res.stdout, /--range/);
}

async function testNoTargetPrintsUsageAndFails() {
    const res = await script([]);
    assert.strictEqual(res.status, 1, 'missing target should exit 1');
    assert.match(res.stdout, /Usage: dexbot liquid /);
}

async function testUnknownFlagFailsWithLiquidUsage() {
    const res = await script(['--bogus']);
    assert.strictEqual(res.status, 1, 'unknown flag should exit 1');
    assert.match(res.stderr, /\[liquid\] Error: Unknown flag "--bogus"\. Usage: dexbot liquid /);
}

async function run() {
    testParseArgsForwardsOptions();
    testParseArgsRejectsBadInput();
    testResolvePairNormalizesCase();
    await Promise.all([
        testHelpPrintsLiquidUsageOffline(),
        testNoTargetPrintsUsageAndFails(),
        testUnknownFlagFailsWithLiquidUsage(),
    ]);
    console.log('liquid cli tests passed');
}

run().catch((err) => {
    console.error(getErrorMessage(err));
    process.exit(1);
});
