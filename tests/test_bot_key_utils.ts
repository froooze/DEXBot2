const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('Running bot_key_utils tests');

const {
    loadBotSettings,
    sanitizeKey,
    computeBotKey,
    resolveBotKey,
    candleFileForBot,
    resolveCandleFile,
    matchBotEntryTarget,
    matchBotAccountTarget,
    matchBotTargetIn,
} = require('../analysis/bot_key_utils');
const { getErrorMessage } = require('../modules/utils/errors');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-bot-key-utils-'));
const tmpDataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(tmpDataDir, { recursive: true });
let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
    } catch (err) {
        failed++;
        console.error(`  FAIL: ${name}`);
        console.error(`    ${err && getErrorMessage(err) ? getErrorMessage(err) : err}`);
        if (err && (err as any).stack) console.error((err as any).stack.split('\n').slice(1, 4).join('\n'));
    }
}

try {

    check('sanitizeKey: null/undefined/empty → "bot"', () => {
        assert.strictEqual(sanitizeKey(null), 'bot');
        assert.strictEqual(sanitizeKey(undefined), 'bot');
        assert.strictEqual(sanitizeKey(''), 'bot');
    });

    check('sanitizeKey: lowercases and kebab-cases', () => {
        assert.strictEqual(sanitizeKey('AAA-BBB'), 'aaa-bbb');
        assert.strictEqual(sanitizeKey('AAA BBB'), 'aaa-bbb');
        assert.strictEqual(sanitizeKey('  My Bot!!  '), 'my-bot');
    });

    check('sanitizeKey: strips leading/trailing dashes', () => {
        assert.strictEqual(sanitizeKey('---foo---'), 'foo');
        assert.strictEqual(sanitizeKey('!!'), 'bot');
    });

    check('computeBotKey: named bot uses sanitized name only', () => {
        const key = computeBotKey({ name: 'AAA-BBB', id: '1.2.123' }, 0);
        assert.strictEqual(key, 'aaa-bbb');
    });

    check('computeBotKey: named bot ignores index', () => {
        const key = computeBotKey({ name: 'AAA-BBB' }, 7);
        assert.strictEqual(key, 'aaa-bbb');
    });

    check('computeBotKey: missing name uses bot-N-index fallback, ignores id', () => {
        const withId = computeBotKey({ id: '1.2.5' }, 3);
        assert.strictEqual(withId, 'bot-3-3');
        const withoutId = computeBotKey({}, 3);
        assert.strictEqual(withoutId, 'bot-3-3');
    });

    check('candleFileForBot: path format', () => {
        const customDir = path.join(tmpRoot, 'custom-data');
        const p = candleFileForBot('aaa-bbb-0', '1h', customDir);
        assert.strictEqual(p, path.join(customDir, 'market_adapter_aaa-bbb-0_1h.json'));
    });

    check('candleFileForBot: defaults to PATHS.MARKET_ADAPTER.DATA_DIR', () => {
        const { PATHS } = require('../modules/paths');
        const p = candleFileForBot('foo', '1h');
        assert.strictEqual(p, path.join(PATHS.MARKET_ADAPTER.DATA_DIR, 'market_adapter_foo_1h.json'));
    });

    const botsFile = path.join(tmpRoot, 'bots.json');
    fs.writeFileSync(botsFile, JSON.stringify({
        bots: [
            { name: 'AAA-BBB', id: '1.2.100', assetA: 'XRP', assetB: 'BTS' },
            { name: 'HONEST-BTC', assetA: 'HONEST.BTC', assetB: 'BTC' },
        ],
    }));

    check('loadBotSettings: missing file returns null', () => {
        assert.strictEqual(loadBotSettings(path.join(tmpRoot, 'missing.json')), null);
    });

    check('loadBotSettings: valid file returns parsed object', () => {
        const loaded = loadBotSettings(botsFile);
        assert.ok(loaded && Array.isArray(loaded.bots) && loaded.bots.length === 2);
        assert.strictEqual(loaded.bots[0].name, 'AAA-BBB');
    });

    check('loadBotSettings: null path returns null', () => {
        assert.strictEqual(loadBotSettings(null), null);
    });

    check('resolveBotKey: name hit returns canonical key', () => {
        const key = resolveBotKey('AAA-BBB', botsFile);
        assert.strictEqual(key, 'aaa-bbb');
    });

    check('resolveBotKey: name hit (no id) uses sanitized name', () => {
        const key = resolveBotKey('HONEST-BTC', botsFile);
        assert.strictEqual(key, 'honest-btc');
    });

    check('resolveBotKey: unknown name returns null', () => {
        assert.strictEqual(resolveBotKey('does-not-exist', botsFile), null);
    });

    check('resolveBotKey: null/empty returns null', () => {
        assert.strictEqual(resolveBotKey(null, botsFile), null);
        assert.strictEqual(resolveBotKey('', botsFile), null);
    });

    const directFile = path.join(tmpDataDir, 'market_adapter_aaa-bbb_1h.json');
    fs.writeFileSync(directFile, '{}');

    check('resolveCandleFile: direct key hit returns direct path', () => {
        const p = resolveCandleFile('aaa-bbb', '1h', tmpDataDir, botsFile);
        assert.strictEqual(p, directFile);
    });

    const fuzzyFile = path.join(tmpDataDir, 'market_adapter_honest-btc_1h.json');
    fs.writeFileSync(fuzzyFile, '{}');

    check('resolveCandleFile: name-only falls back to canonical key lookup', () => {
        const p = resolveCandleFile('HONEST-BTC', '1h', tmpDataDir, botsFile);
        assert.strictEqual(p, fuzzyFile);
    });

    check('resolveCandleFile: unknown bot returns null', () => {
        assert.strictEqual(resolveCandleFile('nope-nope', '1h', tmpDataDir, botsFile), null);
    });

    check('resolveCandleFile: direct hit preferred over name resolution', () => {
        const dataDir2 = path.join(tmpRoot, 'data2');
        fs.mkdirSync(dataDir2, { recursive: true });
        const directOnly = path.join(dataDir2, 'market_adapter_aaa-bbb_1h.json');
        fs.writeFileSync(directOnly, '{}');
        const p = resolveCandleFile('aaa-bbb', '1h', dataDir2, botsFile);
        assert.strictEqual(p, directOnly);
    });

    check('resolveCandleFile: empty data dir is not confused with real PATHS', () => {
        const isolatedDir = path.join(tmpRoot, 'isolated');
        fs.mkdirSync(isolatedDir, { recursive: true });
        const p = resolveCandleFile('whatever', '1h', isolatedDir, botsFile);
        assert.strictEqual(p, null);
    });

    // `<bot|account>` target matching — the one rule set shared by `dexbot
    // credit`, `dexbot order` and the chart commands.
    const targetEntries = [
        { name: 'AAA-BBB', preferredAccount: 'acct-one', accountId: '1.2.11', active: true },
        { name: 'MY BOT', preferredAccount: 'acct-one', active: true },
        { preferredAccount: 'acct-two', assetA: 'CCC', assetB: 'DDD' },
        null,
    ];

    check('matchBotEntryTarget: display name is case/separator-insensitive', () => {
        assert.strictEqual(matchBotEntryTarget(targetEntries[0], 'aaa-bbb', 'aaa-bbb'), 'name');
        assert.strictEqual(matchBotEntryTarget(targetEntries[1], 'my-bot', 'my-bot'), 'name');
    });

    check('matchBotEntryTarget: bot key matches exactly and sanitized', () => {
        assert.strictEqual(matchBotEntryTarget(targetEntries[0], 'aaa-bbb', 'aaa-bbb'), 'name');
        // No entry (a persisted grid with no bots.json match) still matches by key.
        assert.strictEqual(matchBotEntryTarget(null, 'bot-2-2', 'bot-2-2'), 'key');
        assert.strictEqual(matchBotEntryTarget(null, 'BOT 2 2', 'bot-2-2'), 'key');
    });

    check('matchBotEntryTarget: account spellings never match', () => {
        assert.strictEqual(matchBotEntryTarget(targetEntries[0], 'acct-one', 'aaa-bbb'), null);
        assert.strictEqual(matchBotEntryTarget(targetEntries[0], '1.2.11', 'aaa-bbb'), null);
    });

    check('matchBotAccountTarget: preferredAccount name or stamped 1.2.x id', () => {
        assert.strictEqual(matchBotAccountTarget(targetEntries[0], 'acct-one'), true);
        assert.strictEqual(matchBotAccountTarget(targetEntries[0], 'ACCT-ONE'), true);
        assert.strictEqual(matchBotAccountTarget(targetEntries[0], '1.2.11'), true);
        assert.strictEqual(matchBotAccountTarget(targetEntries[0], 'acct-two'), false);
        assert.strictEqual(matchBotAccountTarget(targetEntries[0], ''), false);
        assert.strictEqual(matchBotAccountTarget(null, 'acct-one'), false);
    });

    check('matchBotTargetIn: an account selects every bot on it', () => {
        const matches = matchBotTargetIn(targetEntries, 'acct-one');
        assert.deepStrictEqual(matches.map((m) => m.botKey), ['aaa-bbb', 'my-bot']);
        assert.deepStrictEqual(matches.map((m) => m.matchedBy), ['account', 'account']);
    });

    check('matchBotTargetIn: an account id selects the same bots', () => {
        assert.deepStrictEqual(matchBotTargetIn(targetEntries, '1.2.11').map((m) => m.botKey), ['aaa-bbb']);
    });

    check('matchBotTargetIn: name/key targets identify one entry', () => {
        const byName = matchBotTargetIn(targetEntries, 'my bot');
        assert.deepStrictEqual(byName.map((m) => [m.botKey, m.matchedBy]), [['my-bot', 'name']]);
        // Unnamed bot: the key is the sanitized pair + file index.
        const byKey = matchBotTargetIn(targetEntries, 'ccc-ddd-2');
        assert.deepStrictEqual(byKey.map((m) => [m.botKey, m.matchedBy]), [['ccc-ddd-2', 'key']]);
    });

    check('matchBotTargetIn: blanks and unknown targets match nothing', () => {
        assert.deepStrictEqual(matchBotTargetIn(targetEntries, ''), []);
        assert.deepStrictEqual(matchBotTargetIn(targetEntries, '   '), []);
        assert.deepStrictEqual(matchBotTargetIn(targetEntries, 'nope'), []);
        assert.deepStrictEqual(matchBotTargetIn(null, 'acct-one'), []);
    });

} finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failed > 0) {
    console.error(`bot_key_utils tests FAILED: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`bot_key_utils tests passed (${passed} checks)`);
