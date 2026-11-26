/**
 * SINGLE-CONTROLLER INSTANCE LOCK (per-account).
 *
 * Two bot PROCESSES controlling the SAME account corrupt each other's grids
 * and fills (live incident: a PM2 bot and a `dexbot start` bot traded one
 * account in parallel, cancelling each other's orders as "duplicate orphans"
 * and finally stranding the grid out of spread for ~24h). The lock is keyed
 * by ACCOUNT — the conflict domain is the chain account's open orders. Bots in
 * the SAME process share one lock (monolithic shared-account mode, coordinated
 * by fund_registry), so the guard only refuses a second PROCESS.
 *
 * Pinned here:
 *   1. A live holder in ANOTHER PROCESS blocks an acquire and is named.
 *   2. Two bots in THIS process sharing an account share one lock; in-process
 *      shares are keyed by bot name (unique per config) with one count per live
 *      handle, and the file lock is freed only by the last handle.
 *   3. Release frees the lock for the next controller and is idempotent.
 *   4. A dead holder (crashed process) is taken over, never blocks restart.
 *   5. A recycled pid (payload starttime mismatch) is treated as dead.
 *   6. The payload records account + bot for operator diagnostics.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PATHS = require('../modules/paths').PATHS;
const { getProcessDiscovery } = require('../modules/process_discovery');
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

function spawnKeepAlive(): ReturnType<typeof spawn> {
    return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
}

test('the lock directory defaults under profiles', () => {
    PATHS.PROFILES.INSTANCE_LOCKS_DIR = savedLocksDir;
    assert.match(savedLocksDir, /instance-locks$/);
    PATHS.PROFILES.INSTANCE_LOCKS_DIR = tmpDir;
});

test('LOCK-1 a live holder in another process blocks an acquire and names it', async () => {
    useTempLocksDir();
    // A child process stands in for a foreign controller. A same-process
    // sibling must NOT trip the guard (see LOCK-8), so the planted lock has to
    // carry a pid this process does not own.
    const foreign = spawnKeepAlive();
    await new Promise<void>((resolve, reject) => {
        foreign.once('spawn', () => resolve());
        foreign.once('error', reject);
    });
    try {
        const lockPath = path.join(tmpDir, 'account-one.lock');
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: foreign.pid,
            botName: 'bot-a',
            account: 'account-one',
            starttime: Number(getProcessDiscovery().readStat(foreign.pid)?.starttime ?? 0),
            at: new Date().toISOString(),
        }));
        let holderPid = '';
        assert.throws(
            () => acquireBotInstanceLock('account-one', 'bot-b'),
            (err: any) => {
                assert.match(String(err.message), /already controlled by another bot process/);
                const m = String(err.message).match(/pid (\d+)/);
                holderPid = m ? m[1] : '';
                assert.strictEqual(Number(holderPid), foreign.pid, `the foreign holder pid must be named (got: ${err.message})`);
                assert.match(String(err.message), /bot bot-a/, 'the holder bot name must be named');
                assert.match(String(err.message), /dexbot pm2 stop/, 'the message must tell the operator how to stop it');
                return true;
            }
        );
    } finally {
        foreign.kill('SIGKILL');
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

test('LOCK-8 two bots in this process share one account lock', () => {
    useTempLocksDir();
    const lockPath = path.join(tmpDir, 'account-nine.lock');
    const a = acquireBotInstanceLock('account-nine', 'bot-a');
    const b = acquireBotInstanceLock('account-nine', 'bot-b');
    try {
        assert.ok(fs.existsSync(lockPath), 'a lock file exists');
        const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.strictEqual(payload.botName, 'bot-a', 'the underlying file lock is acquired only once');
        assert.strictEqual(typeof a.release, 'function');
        assert.strictEqual(typeof b.release, 'function');
    } finally {
        a.release();
        b.release();
    }
    assert.ok(!fs.existsSync(lockPath), 'the lock is released after the last sharer shuts down');
});

test('LOCK-9 a bot-name share is idempotent and released by the last bot', () => {
    useTempLocksDir();
    const lockPath = path.join(tmpDir, 'account-ten.lock');
    const a = acquireBotInstanceLock('account-ten', 'bot-a');
    const b = acquireBotInstanceLock('account-ten', 'bot-b');
    const ownerA = JSON.parse(fs.readFileSync(lockPath, 'utf8')).ownerId;
    a.release();
    a.release(); // must not release b's share or free the file lock twice
    assert.ok(fs.existsSync(lockPath), 'the remaining bot still holds the file lock');
    const stillOwnerA = JSON.parse(fs.readFileSync(lockPath, 'utf8')).ownerId;
    assert.strictEqual(stillOwnerA, ownerA, 'the surviving bot keeps the original lock');
    b.release();
    assert.ok(!fs.existsSync(lockPath), 'last release frees the file lock');

    const c = acquireBotInstanceLock('account-ten', 'bot-c');
    try {
        const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.strictEqual(payload.botName, 'bot-c', 'a fresh acquire after full release re-creates the lock');
        assert.notStrictEqual(payload.ownerId, ownerA, 'the fresh acquisition gets a fresh ownership token');
    } finally {
        c.release();
    }
});

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

test('LOCK-10 a real SECOND PROCESS holding the lock still blocks (PM2/unlock guard backstop)', async () => {
    useTempLocksDir();
    const pathsPath = require.resolve('../modules/paths');
    const lockModulePath = require.resolve('../modules/launcher/instance_lock');
    // A child really acquires the lock through the public API — the same
    // situation as a PM2 bot while `dexbot start` (or vice versa) is live.
    const code =
        `const PATHS = require(${JSON.stringify(pathsPath)}).PATHS;` +
        `PATHS.PROFILES.INSTANCE_LOCKS_DIR = ${JSON.stringify(tmpDir)};` +
        `const { acquireBotInstanceLock } = require(${JSON.stringify(lockModulePath)});` +
        `acquireBotInstanceLock('account-cross-process', 'bot-pm2');` +
        `process.stdout.write(String(process.pid) + '\\n');` +
        `setInterval(() => {}, 1000);`;
    const foreign = spawn(process.execPath, ['-e', code]);
    const holderPid = await new Promise<number>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error('child did not publish its pid in time')), 10000);
        foreign.stdout?.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            const m = out.match(/(\d+)/);
            if (m) {
                clearTimeout(timer);
                resolve(Number(m[1]));
            }
        });
        foreign.once('error', (err) => { clearTimeout(timer); reject(err); });
        foreign.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`child exited before publishing pid (code ${code})`));
        });
    });
    try {
        assert.ok(holderPid > 0);
        assert.throws(
            () => acquireBotInstanceLock('account-cross-process', 'bot-unlock'),
            (err: any) => {
                assert.match(String(err.message), /already controlled by another bot process/);
                assert.match(String(err.message), new RegExp(`pid ${holderPid}\\b`), 'the other process pid must be named');
                assert.match(String(err.message), /bot bot-pm2/, 'the other process bot name must be named');
                return true;
            }
        );
    } finally {
        foreign.kill('SIGKILL');
        await waitForExit(foreign);
    }
    // Dead foreign holder: the account is immediately available again.
    const takeover = acquireBotInstanceLock('account-cross-process', 'bot-unlock');
    takeover.release();
});

test('LOCK-11 one bot-name share per live handle (no premature release)', () => {
    useTempLocksDir();
    const lockPath = path.join(tmpDir, 'account-thirteen.lock');
    const a1 = acquireBotInstanceLock('account-thirteen', 'bot-a');
    const a2 = acquireBotInstanceLock('account-thirteen', 'bot-a');
    const b = acquireBotInstanceLock('account-thirteen', 'bot-b');
    a1.release();
    assert.ok(fs.existsSync(lockPath), 'the duplicate bot-a handle still holds a share');
    a2.release();
    assert.ok(fs.existsSync(lockPath), 'bot-b still holds the lock');
    b.release();
    assert.ok(!fs.existsSync(lockPath), 'the last handle frees the file lock');
});

test('LOCK-12 unnamed acquisitions still get distinct shares', () => {
    useTempLocksDir();
    const lockPath = path.join(tmpDir, 'account-fourteen.lock');
    const first = acquireBotInstanceLock('account-fourteen', '');
    const second = acquireBotInstanceLock('account-fourteen', '');
    first.release();
    assert.ok(fs.existsSync(lockPath), 'the second unnamed holder still holds the lock');
    second.release();
    assert.ok(!fs.existsSync(lockPath));
});

test('LOCK-13 distinct accounts colliding on the sanitized filename still contend', () => {
    useTempLocksDir();
    // 'Foo/Bar' and 'foo_bar' both sanitize to foo_bar.lock. The in-process
    // registry is keyed by the RAW account, so they must NOT be treated as
    // siblings sharing one lock.
    const first = acquireBotInstanceLock('Foo/Bar', 'bot-a');
    try {
        assert.throws(
            () => acquireBotInstanceLock('foo_bar', 'bot-b'),
            /already controlled by another bot process/
        );
    } finally {
        first.release();
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
