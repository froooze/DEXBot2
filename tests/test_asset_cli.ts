'use strict';

/**
 * Regression guard for `dexbot asset <bts|symbol>` (shorthand `dexbot a`).
 *
 * The command is a router (scripts/asset.ts): `bts` (or the core asset id)
 * routes to the BTS analyzer, any other symbol/id to the token analyzer, and
 * the flag list is forwarded untouched. These tests cover target parsing, flag
 * routing and the offline entry-point behavior (help, missing target,
 * wrong-target flags) — none of them may reach the chain.
 */

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running asset cli tests');

const { parseArgs, ANALYZERS, CORE_ASSET_ID } = require('../scripts/asset');
require('../scripts/asset'); // entry must load WITHOUT auto-invoking an analyzer

const ASSET_SCRIPT = path.join(__dirname, '..', 'scripts', 'asset.js');
const DEXBOT_ENTRY = path.join(__dirname, '..', 'dexbot.js');

function testBtsTarget() {
    const parsed = parseArgs(['bts']);
    assert.strictEqual(parsed.kind, 'bts');
    assert.strictEqual(parsed.asset, null);
    assert.deepStrictEqual(parsed.scriptArgs, []);

    // Case-insensitive core symbol and the core asset id both route to bts.
    assert.strictEqual(parseArgs(['BTS']).kind, 'bts');
    assert.strictEqual(parseArgs([CORE_ASSET_ID]).kind, 'bts');

    const flags = parseArgs(['bts', '--holders', 'all', '--circulating', '1234.5', '--json']);
    assert.strictEqual(flags.kind, 'bts');
    assert.deepStrictEqual(flags.scriptArgs, ['--holders', 'all', '--circulating', '1234.5', '--json']);
}

function testIssuedAssetTarget() {
    const symbol = parseArgs(['TOKENA', '--no-orders']);
    assert.strictEqual(symbol.kind, 'token');
    assert.strictEqual(symbol.asset, 'TOKENA');
    assert.deepStrictEqual(symbol.scriptArgs, ['--no-orders']);

    const byId = parseArgs(['1.3.123', '--concurrency', '8']);
    assert.strictEqual(byId.kind, 'token');
    assert.strictEqual(byId.asset, '1.3.123');
    assert.deepStrictEqual(byId.scriptArgs, ['--concurrency', '8']);

    // `--flag=value` keeps its inline form.
    const inline = parseArgs(['TOKENA', '--detail=20', '--json']);
    assert.deepStrictEqual(inline.scriptArgs, ['--detail=20', '--json']);
}

function testSharedFlagsForward() {
    const parsed = parseArgs(['TOKENA', '--node', 'wss://node.example/ws', '--vesting-max', '5000', '--gap', '50', '--html', 'out.html', '--no-html']);
    assert.deepStrictEqual(parsed.scriptArgs, [
        '--node', 'wss://node.example/ws',
        '--vesting-max', '5000',
        '--gap', '50',
        '--html', 'out.html',
        '--no-html',
    ]);
}

function testHelpAndMissingTarget() {
    assert.strictEqual(parseArgs(['--help']).help, true);
    assert.strictEqual(parseArgs(['bts', '--help']).help, true);
    assert.strictEqual(parseArgs(['TOKENA', '-h']).help, true);
    assert.strictEqual(parseArgs([]).kind, null);
}

function testRejectsBadInput() {
    // `token` is not a word in this grammar — a target is `bts` or the symbol.
    assert.throws(() => parseArgs(['token', 'TOKENA']), /`token` is not a subcommand: pass the symbol directly/);
    assert.throws(() => parseArgs(['bts', '--no-orders']), /--no-orders applies to issued assets only; the core asset uses --holders and --circulating\./);
    assert.throws(() => parseArgs(['TOKENA', '--holders', 'all']), /Unknown flag "--holders"\. Usage: dexbot asset /);
    assert.throws(() => parseArgs(['bts', 'extra']), /Unexpected argument "extra"\. Usage: dexbot asset /);
    assert.throws(() => parseArgs(['bts', '--detail']), /Missing value for --detail/);
    assert.throws(() => parseArgs(['--bogus']), /Expected a target \(bts or an asset symbol\/id\)/);
}

function testAnalyzerTable() {
    assert.strictEqual(ANALYZERS.bts.script, 'bts_distribution.js');
    assert.strictEqual(ANALYZERS.token.script, 'token_distribution.js');
    assert.strictEqual(CORE_ASSET_ID, '1.3.0');
}

function script(entry: string, argv: string[]) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [entry, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${entry} probe timed out`)); }, 30000);
        child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
        child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
        child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
        child.on('close', (status: number | null) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

async function testHelpPrintsAssetUsageOffline() {
    const res = await script(ASSET_SCRIPT, ['--help']);
    assert.strictEqual(res.status, 0, `--help should exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /Usage: dexbot asset </);
    assert.match(res.stdout, /<symbol\|1\.3\.x>\s+Issued-asset distribution/);
    assert.match(res.stdout, /--holders N\|all/);
}

async function testNoTargetPrintsUsageAndFails() {
    const res = await script(ASSET_SCRIPT, []);
    assert.strictEqual(res.status, 1, 'missing target should exit 1');
    assert.match(res.stdout, /Usage: dexbot asset </);
}

async function testWrongTargetFlagFailsBeforeChainWork() {
    const res = await script(ASSET_SCRIPT, ['bts', '--no-orders']);
    assert.strictEqual(res.status, 1, 'an issued-asset-only flag on bts should exit 1');
    assert.match(res.stderr, /\[Assets\] Error: --no-orders applies to issued assets only/);
}

async function testRemovedTokenKeywordFailsBeforeChainWork() {
    const res = await script(ASSET_SCRIPT, ['token', 'TOKENA']);
    assert.strictEqual(res.status, 1, 'the `token` keyword should exit 1');
    assert.match(res.stderr, /\[Assets\] Error: `token` is not a subcommand/);
}

async function testDexbotForwardsHelpToAsset() {
    // `asset` is a help-owning command: dexbot must forward -h instead of
    // printing the global usage, so the router's own flags stay discoverable.
    const res = await script(DEXBOT_ENTRY, ['asset', '--help']);
    assert.strictEqual(res.status, 0, `dexbot asset --help should exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /Usage: dexbot asset </);
}

async function testShorthandAliasForwardsHelp() {
    // `a` must resolve to `asset` before the help-owning check, otherwise the
    // shorthand would print the global CLI usage instead.
    const res = await script(DEXBOT_ENTRY, ['a', '--help']);
    assert.strictEqual(res.status, 0, `dexbot a --help should exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /Usage: dexbot asset </, 'dexbot a --help should print the asset usage');
}

async function testHelpListsAssetCommand() {
    const res = await script(DEXBOT_ENTRY, ['--help']);
    assert.strictEqual(res.status, 0, `dexbot --help should exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /asset <bts\|symbol>\s+Supply distribution/);
    assert.match(res.stdout, /shorthand: a/);
}

async function run() {
    testBtsTarget();
    testIssuedAssetTarget();
    testSharedFlagsForward();
    testHelpAndMissingTarget();
    testRejectsBadInput();
    testAnalyzerTable();
    await testHelpPrintsAssetUsageOffline();
    await testNoTargetPrintsUsageAndFails();
    await testWrongTargetFlagFailsBeforeChainWork();
    await testRemovedTokenKeywordFailsBeforeChainWork();
    await testDexbotForwardsHelpToAsset();
    await testShorthandAliasForwardsHelp();
    await testHelpListsAssetCommand();
    console.log('asset cli tests passed');
}

run().catch((err) => {
    console.error(getErrorMessage(err));
    process.exit(1);
});
