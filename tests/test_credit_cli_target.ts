'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running credit CLI target tests');

// `dexbot credit <target>` accepts a bot name/key or the chain account behind
// the bot. Only the pre-chain branches are exercised here (help, matched but
// unconfigured, unknown target) so the test stays offline and read-only; the
// live per-account report path is covered by the helper test plus live suites.

const DEXBOT_ENTRY = path.join(__dirname, '..', 'dexbot.js');

const BOTS = {
    bots: [
        {
            name: 'market-a',
            preferredAccount: 'acct-one',
            accountId: '1.2.11',
            active: true,
            assetA: 'AAA',
            assetB: 'BBB',
            debtPolicy: { lending: [{ asset: 'AAA', collateralAsset: 'BBB', type: 'creditOffer' }] },
        },
        { name: 'market-b', preferredAccount: 'acct-two', active: true, assetA: 'CCC', assetB: 'DDD' },
        { name: 'market-c', preferredAccount: 'acct-three', active: false, assetA: 'EEE', assetB: 'FFF' },
        {
            name: 'market-d',
            preferredAccount: 'acct-two',
            active: false,
            assetA: 'GGG',
            assetB: 'HHH',
            debtPolicy: { lending: [{ asset: 'GGG', collateralAsset: 'HHH', type: 'creditOffer' }] },
        },
    ],
};

function makeProfileRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-cli-'));
    fs.writeFileSync(path.join(root, 'bots.json'), JSON.stringify(BOTS, null, 2));
    return root;
}

function credit(profileRoot, argv) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [DEXBOT_ENTRY, 'credit', ...argv], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                DEXBOT_PROFILE_ROOT: profileRoot,
                // Keep the relocated-state notices out of the asserted output.
                DEXBOT_MARKET_ADAPTER_DATA_DIR: path.join(profileRoot, 'market_adapter'),
                DEXBOT_MARKET_ADAPTER_STATE_DIR: path.join(profileRoot, 'market_adapter', 'state'),
                DEXBOT_CLAW_DATA_DIR: path.join(profileRoot, 'claw', 'data'),
            },
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('dexbot credit probe timed out')); }, 30000);
        child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
        child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
        child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
        child.on('close', (status: number | null) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

async function testHelpAcceptsAccountTarget(profileRoot: string) {
    const res = await credit(profileRoot, ['--help']);
    assert.strictEqual(res.status, 0, `credit --help should exit 0: ${res.stderr}`);
    assert.match(res.stdout, /Usage: dexbot credit \[<bot\|account>\]/);
    assert.match(res.stdout, /preferredAccount name or 1\.2\.x id/);
}

async function testAccountWithoutDebtPolicyIsReported(profileRoot: string) {
    // acct-two belongs to market-b, which has no debtPolicy.lending: the command
    // must say so instead of claiming the target does not exist.
    const res = await credit(profileRoot, ['acct-two']);
    assert.strictEqual(res.status, 0, `credit acct-two should exit 0: ${res.stderr}`);
    assert.match(res.stdout, /Matched 'acct-two' but no enabled entry has debtPolicy\.lending/);
    assert.match(res.stdout, /market-b \(account: acct-two\) \(no debtPolicy\)/);
    // The disabled entry on the same account *does* carry the policy, so the
    // hint must offer both remedies instead of claiming no entry has one.
    assert.match(res.stdout, /market-d \(account: acct-two\) \(inactive\)/);
    assert.match(res.stdout, /Add a debtPolicy via `dexbot bot`/);
    assert.match(res.stdout, /Disabled entries also need `dexbot enable <bot>` first\./);
}

async function testEnabledTargetWithoutPolicyIsReported(profileRoot: string) {
    // Only enabled matches lack the policy: the enable hint must not appear.
    const res = await credit(profileRoot, ['market-b']);
    assert.strictEqual(res.status, 0, `credit market-b should exit 0: ${res.stderr}`);
    assert.match(res.stdout, /but no enabled entry has debtPolicy\.lending/);
    assert.doesNotMatch(res.stdout, /Disabled entries also need/);
}

async function testInactiveAccountTargetIsReported(profileRoot: string) {
    const res = await credit(profileRoot, ['acct-three']);
    assert.strictEqual(res.status, 0, `credit acct-three should exit 0: ${res.stderr}`);
    assert.match(res.stdout, /Matched 'acct-three' only on inactive entries/);
    assert.match(res.stdout, /market-c \(account: acct-three\) \(no debtPolicy\) \(inactive\)/);
}

async function testUnknownTargetListsAccounts(profileRoot: string) {
    const res = await credit(profileRoot, ['no-such-target']);
    assert.strictEqual(res.status, 0, `credit no-such-target should exit 0: ${res.stderr}`);
    assert.match(res.stdout, /No credit bot or account found for 'no-such-target'/);
    assert.match(res.stdout, /market-a \(account: acct-one\)/);
    assert.match(res.stdout, /market-b \(account: acct-two\) \(no debtPolicy\)/);
}

async function run() {
    const profileRoot = makeProfileRoot();
    try {
        await testHelpAcceptsAccountTarget(profileRoot);
        await testAccountWithoutDebtPolicyIsReported(profileRoot);
        await testEnabledTargetWithoutPolicyIsReported(profileRoot);
        await testInactiveAccountTargetIsReported(profileRoot);
        await testUnknownTargetListsAccounts(profileRoot);
    } finally {
        fs.rmSync(profileRoot, { recursive: true, force: true });
    }
    console.log('Credit CLI target tests passed');
}

run().catch((err) => {
    console.error(getErrorMessage(err));
    process.exit(1);
});
