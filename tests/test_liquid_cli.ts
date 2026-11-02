const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Resolve bot targets against an empty fixture profile so a pool-token target
// can never accidentally match a developer's bot name.
process.env.DEXBOT_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-liquid-cli-'));
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running liquid cli tests');

// `dexbot liquid` (scripts/liquid.ts) resolves a bot/pool/pair target and
// forwards the liquidity options to analysis/analyze_liquidity.js. These tests
// cover parsing/normalization, pool target routing (id or pool token) and the
// offline entry-point behavior (help / missing target / bad flag must not touch
// the network).

const { parseArgs, resolveTarget, analyzerArgsFor } = require('../scripts/liquid');
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

function testPoolTargets() {
    // Pool by id: numeric and object-id spellings both route to the analyzer's
    // --pool, which owns the id normalization.
    assert.deepStrictEqual(resolveTarget('133'), { pool: '133' });
    assert.deepStrictEqual(resolveTarget('1.19.133'), { pool: '1.19.133' });
    // Pool token (LP share-asset symbol) is a valid pool target too.
    assert.deepStrictEqual(resolveTarget('POOLTOK'), { pool: 'POOLTOK' });
    // Only impossible references fail locally (spaces / path characters).
    assert.throws(() => resolveTarget('not a pool'), /Unknown target "not a pool"\. Use a bot name\/key/);
}

function testAnalyzerArgsForTargets() {
    // The analyzer takes --pool for pool targets and --pair for pairs; option
    // order after the target is preserved.
    assert.deepStrictEqual(
        analyzerArgsFor({ pool: '1.19.133' }, ['--range', '0.3', '--quiet']),
        ['--pool', '1.19.133', '--range', '0.3', '--quiet'],
    );
    assert.deepStrictEqual(
        analyzerArgsFor({ base: 'TOKENA', quote: 'TOKENB' }, ['--depth', '100']),
        ['--pair', 'TOKENA/TOKENB', '--depth', '100'],
    );
    // A pool target plus --pool would chart a different pool: rejected, not
    // silently resolved by "last one wins".
    assert.throws(
        () => analyzerArgsFor({ pool: '1.19.133' }, ['--pool', '1.19.54']),
        /Target already names a pool; drop --pool/,
    );
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
    assert.match(res.stdout, /Usage: dexbot liquid <bot\|pool\|AssetA\/AssetB>/);
    assert.match(res.stdout, /--range/);
    assert.match(res.stdout, /--pool <ref>/);
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
    testPoolTargets();
    testAnalyzerArgsForTargets();
    await Promise.all([
        testHelpPrintsLiquidUsageOffline(),
        testNoTargetPrintsUsageAndFails(),
        testUnknownFlagFailsWithLiquidUsage(),
    ]);
    fs.rmSync(process.env.DEXBOT_PROFILE_ROOT as string, { recursive: true, force: true });
    console.log('liquid cli tests passed');
}

run().catch((err) => {
    console.error(getErrorMessage(err));
    process.exit(1);
});
