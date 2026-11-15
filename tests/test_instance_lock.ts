/**
 * SINGLE-CONTROLLER INSTANCE LOCK (per-account).
 *
 * Two bot processes controlling the SAME account corrupt each other's grids
 * and fills (live incident: a PM2 bot and a `dexbot start` bot traded one
 * account in parallel, cancelling each other's orders as "duplicate orphans"
 * and finally stranding the grid out of spread for ~24h). The lock is keyed
 * by ACCOUNT — the conflict domain is the chain account's open orders, so
 * even two differently named bot entries sharing an account conflict.
 *
 * Pinned here:
 *   1. A second acquire while a live holder exists throws, naming the holder.
 *   2. Release frees the lock for the next controller.
 *   3. A dead holder (crashed process) is taken over, never blocks restart.
 *   4. A recycled pid (payload starttime mismatch) is treated as dead.
 *   5. The payload records account + bot for operator diagnostics.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PATHS = require('../modules/paths').PATHS;
const { acquireBotInstanceLock } = require('../modules/launcher/instance_lock');

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void | Promise<void>) {
    const done = (err: unknown) => {
        if (!err) {
            passed++;
            console.log(`  ✓ ${name}`);
        } else {
            failed++;
            console.error(`  ✗ ${name}`);
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`    ${msg}`);
        }
        next();
    };
    try {
        const r = fn();
        if (r instanceof Promise) r.then(() => done(null), done);
        else done(null);
    } catch (err) {
        done(err);
    }
}

const tests: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push([name, fn]); }

let tmpDir = '';
const savedLocksDir = PATHS.PROFILES.INSTANCE_LOCKS_DIR;

function useTempLocksDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-instance-lock-'));
    PATHS.PROFILES.INSTANCE_LOCKS_DIR = tmpDir;
}

test('the lock directory defaults under profiles', () => {
    PATHS.PROFILES.INSTANCE_LOCKS_DIR = savedLocksDir;
    assert.match(savedLocksDir, /instance-locks$/);
    PATHS.PROFILES.INSTANCE_LOCKS_DIR = tmpDir;
});

test('LOCK-1 a live holder blocks a second acquire and names it', async () => {
    useTempLocksDir();
    const lock = acquireBotInstanceLock('account-one', 'bot-a');
    try {
        let holderPid = '';
        assert.throws(
            () => acquireBotInstanceLock('account-one', 'bot-b'),
            (err: any) => {
                assert.match(String(err.message), /already controlled by another bot process/);
                const m = String(err.message).match(/pid (\d+)/);
                holderPid = m ? m[1] : '';
                assert.ok(holderPid && Number(holderPid) > 0, `the holder pid must be named (got: ${err.message})`);
                assert.match(String(err.message), /bot bot-a/, 'the holder bot name must be named');
                assert.match(String(err.message), /dexbot pm2 stop/, 'the message must tell the operator how to stop it');
                return true;
            }
        );
    } finally {
        lock.release();
    }
});

test('LOCK-2 a second account is NOT blocked (the lock is per-account)', () => {
    const lockA = acquireBotInstanceLock('account-two', 'bot-a');
    let lockB: any = null;
    try {
        lockB = acquireBotInstanceLock('account-three', 'bot-b');
        assert.strictEqual(typeof lockB.release, 'function');
    } finally {
        lockB?.release();
        lockA.release();
    }
});

test('LOCK-3 release frees the lock (same-named bot can re-acquire immediately)', () => {
    const lock = acquireBotInstanceLock('account-four', 'bot-a');
    lock.release();
    const lock2 = acquireBotInstanceLock('account-four', 'bot-a');
    lock2.release();
});

test('LOCK-4 release is idempotent', () => {
    const lock = acquireBotInstanceLock('account-five', 'bot-a');
    lock.release();
    assert.doesNotThrow(() => lock.release());
});

test('LOCK-5 a DEAD holder (crashed process) is taken over, not blocking restart', async () => {
    useTempLocksDir();
    // Spawn a short-lived process and let it exit while holding nothing: its
    // pid then looks like "the crashed predecessor" for the payload we plant.
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>((resolve, reject) => {
        dead.on('exit', () => resolve());
        dead.on('error', reject);
    });
    const deadPid = dead.pid;
    const lockPath = path.join(tmpDir, 'account-six.lock');
    const deadStarttime = 12345; // never matches any live process we compare against
    fs.writeFileSync(lockPath, JSON.stringify({
        pid: deadPid, botName: 'bot-crashed', account: 'account-six', starttime: deadStarttime, at: new Date().toISOString()
    }));
    const lock = acquireBotInstanceLock('account-six', 'bot-fresh');
    try {
        const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.strictEqual(payload.botName, 'bot-fresh', 'the takeover must rewrite the payload');
    } finally {
        lock.release();
    }
});

test('LOCK-6 a recycled pid (starttime mismatch) is treated as dead', () => {
    useTempLocksDir();
    // Plant a payload claiming the CURRENT process pid with a starttime that
    // cannot match ours: an honest aliveCheck must refuse the holder.
    const lockPath = path.join(tmpDir, 'account-seven.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid, botName: 'ghost', account: 'account-seven', starttime: 999999999, at: new Date().toISOString()
    }));
    const lock = acquireBotInstanceLock('account-seven', 'bot-fresh');
    try {
        const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.strictEqual(payload.botName, 'bot-fresh');
    } finally {
        lock.release();
    }
});

test('LOCK-7 the payload records account + bot + pid for diagnostics', () => {
    useTempLocksDir();
    const lock = acquireBotInstanceLock('account-eight', 'bot-diag');
    try {
        const payload = JSON.parse(fs.readFileSync(path.join(tmpDir, 'account-eight.lock'), 'utf8'));
        assert.strictEqual(payload.account, 'account-eight');
        assert.strictEqual(payload.botName, 'bot-diag');
        assert.ok(Number(payload.pid) > 0);
        assert.ok(Number(payload.starttime) > 0, 'the pid-recycle identity must be recorded');
    } finally {
        lock.release();
    }
});

// Run sequentially.
function next() {
    if (tests.length === 0) {
        console.log(`\n${passed} passed, ${failed} failed`);
        process.exit(failed > 0 ? 1 : 0);
    }
    const [name, fn] = tests.shift() as [string, () => void | Promise<void>];
    run(name, fn);
}
next();
