'use strict';

/**
 * Pins the shared CLI status style (modules/cli_progress.ts).
 *
 * The point of the module is that `dexbot liq`, the chart exporters and the
 * supply distribution analyzers print the *same* `[Tag] …` lines instead of
 * each re-implementing the escape sequences and trailer wording. These tests
 * lock the format and the TTY/`enabled` guards so a refactor cannot silently
 * change the output of every analysis command at once.
 */

const assert = require('assert');
const { CLI_TAGS, progressLine, clearProgressLine, taggedProgress, savedLine } = require('../modules/cli_progress');

console.log('Running cli progress tests');

const CLEAR_LINE = '\r\x1b[2K';

/** Capture stderr writes while pretending to be an interactive terminal. */
function captureProgress(run: () => void) {
    const stderr = process.stderr;
    const originalWrite = stderr.write;
    const originalTTY = stderr.isTTY;
    let captured = '';
    try {
        stderr.isTTY = true;
        stderr.write = (chunk) => { captured += String(chunk); return true; };
        run();
    } finally {
        stderr.write = originalWrite;
        stderr.isTTY = originalTTY;
    }
    return captured;
}

function testTags() {
    assert.strictEqual(CLI_TAGS.assets, '[Assets]');
    assert.strictEqual(CLI_TAGS.liquidity, '[Liquidity]');
    assert.strictEqual(CLI_TAGS.tradingView, '[TradingView]');
    assert.strictEqual(CLI_TAGS.dynamicWeight, '[DynamicWeight]');
}

function testProgressFormat() {
    const out = captureProgress(() => progressLine(CLI_TAGS.assets, true, 'scanning vesting balances ... 100'));
    assert.strictEqual(out, `${CLEAR_LINE}[Assets] scanning vesting balances ... 100`);
}

function testProgressOverwritesAndClears() {
    const out = captureProgress(() => {
        progressLine(CLI_TAGS.assets, true, 'a');
        progressLine(CLI_TAGS.assets, true, 'b');
        clearProgressLine();
    });
    assert.strictEqual(out, `${CLEAR_LINE}[Assets] a${CLEAR_LINE}[Assets] b${CLEAR_LINE}`);
}

function testDisabledAndNonTtyAreSilent() {
    // `enabled: false` (e.g. --json) never writes, even on a TTY.
    assert.strictEqual(captureProgress(() => progressLine(CLI_TAGS.assets, false, 'x')), '');
    assert.strictEqual(captureProgress(() => clearProgressLine(false)), '');

    // A piped stderr (no TTY) must stay silent, so redirected output is clean.
    const stderr = process.stderr;
    const originalWrite = stderr.write;
    const originalTTY = stderr.isTTY;
    let captured = '';
    try {
        stderr.isTTY = false;
        stderr.write = (chunk) => { captured += String(chunk); return true; };
        progressLine(CLI_TAGS.assets, true, 'x');
        clearProgressLine();
    } finally {
        stderr.write = originalWrite;
        stderr.isTTY = originalTTY;
    }
    assert.strictEqual(captured, '');
}

function testTaggedProgressBindsTag() {
    const progress = taggedProgress(CLI_TAGS.pnl);
    const out = captureProgress(() => progress(true, 'loading fills ...'));
    assert.strictEqual(out, `${CLEAR_LINE}[PnL] loading fills ...`);
}

function testSavedLine() {
    assert.strictEqual(
        savedLine(CLI_TAGS.assets, 'Report', 'file:///tmp/bts-distribution.html'),
        '\n[Assets] ✓ Report saved. Open report: (file:///tmp/bts-distribution.html)',
    );
    assert.strictEqual(
        savedLine(CLI_TAGS.liquidity, 'Chart', 'file:///tmp/liquidity_A_B.html'),
        '\n[Liquidity] ✓ Chart saved. Open chart: (file:///tmp/liquidity_A_B.html)',
    );
}

function run() {
    testTags();
    testProgressFormat();
    testProgressOverwritesAndClears();
    testDisabledAndNonTtyAreSilent();
    testTaggedProgressBindsTag();
    testSavedLine();
    console.log('cli progress tests passed');
}

try {
    run();
} catch (err) {
    console.error(err);
    process.exit(1);
}
