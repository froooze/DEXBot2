const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running CLI alias tests');

// Alias resolution lives in dexbot.ts, which is a side-effecting entrypoint
// rather than an importable module. Exercise it end-to-end instead: every
// documented spelling of the liquidity command must reach the liquid script's
// offline `--help` path (proving the alias map and the help-owning check agree).

const DEXBOT_ENTRY = path.join(__dirname, '..', 'dexbot.js');

function dexbot(argv: string[]) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [DEXBOT_ENTRY, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('dexbot alias probe timed out')); }, 30000);
        child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
        child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
        child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
        child.on('close', (status: number | null) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

async function testLiquidSpellingsForwardHelp() {
    // `liq` is the default shorthand; `liqu`/`liquidity` are alternates and
    // `liquid` is the canonical command.
    for (const spelling of ['liq', 'liqu', 'liquidity', 'liquid']) {
        const res = await dexbot([spelling, '--help']);
        assert.strictEqual(res.status, 0, `dexbot ${spelling} --help should exit 0, got ${res.status}: ${res.stderr}`);
        assert.match(res.stdout, /Usage: dexbot liquid /, `dexbot ${spelling} --help should print liquid usage`);
    }
}

async function testHelpListsDefaultShorthand() {
    const res = await dexbot(['--help']);
    assert.strictEqual(res.status, 0, `dexbot --help should exit 0, got ${res.status}: ${res.stderr}`);
    // `liquid` is the command row and the shorthand lives in its description,
    // so the canonical name and the aliases stay on one line.
    assert.match(res.stdout, /liquid <target>\s+Liquidity depth chart/);
    assert.match(res.stdout, /aliases: liq, liqu, liquidity/);
}

async function run() {
    await testLiquidSpellingsForwardHelp();
    await testHelpListsDefaultShorthand();
    console.log('CLI alias tests passed');
}

run().catch((err) => {
    console.error(getErrorMessage(err));
    process.exit(1);
});
