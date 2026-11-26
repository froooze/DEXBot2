const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('Running bot settings tests');

const {
    normalizeBotEntries,
    resolveRawBotEntries,
    selectActiveBotEntries,
    selectBotEntry,
    validateBotEntry,
    loadSettingsFile,
    collectValidationIssues,
} = require('../modules/bot_settings');

const raw = {
    bots: [
        { name: 'A', active: false, debtPolicy: { lending: [{ asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', maxCollateralRatio: 2.0 }] } },
        { name: 'B', assetA: 'BTS', assetB: 'USD' },
    ],
};

assert.deepStrictEqual(
    resolveRawBotEntries(raw).map((bot) => bot.name),
    ['A', 'B'],
    'resolveRawBotEntries should return the bots array'
);

assert.strictEqual(
    resolveRawBotEntries(raw)[0].debtPolicy.lending[0].asset,
    'USD',
    'resolveRawBotEntries should preserve debtPolicy fields'
);

assert.deepStrictEqual(
    selectActiveBotEntries(raw).map((bot) => bot.name),
    ['B'],
    'selectActiveBotEntries should filter inactive bots'
);

assert.strictEqual(selectBotEntry(raw, 'B').name, 'B', 'selectBotEntry should find the named bot');

const normalized = normalizeBotEntries([{ name: 'B', assetA: 'BTS', assetB: 'USD' }]);
assert.strictEqual(normalized[0].botIndex, 0, 'normalizeBotEntries should add the bot index');
assert.ok(normalized[0].botKey, 'normalizeBotEntries should create a bot key');

// Test: collateralAsset is required
const missingCollateralAsset = {
    name: 'C',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            { asset: 'USD', type: 'mpa', targetCollateralRatio: 2.0 },
        ],
    },
};

assert(
    validateBotEntry(missingCollateralAsset, 0, 'test').includes('collateralAsset'),
    'validateBotEntry should require collateralAsset'
);

// Test: lending array is required
const missingLending = {
    name: 'D',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
    },
};

assert(
    validateBotEntry(missingLending, 0, 'test').includes('lending'),
    'validateBotEntry should require lending array'
);

// Test: creditOffer maxCollateralRatio is required
const invalidCreditOfferRatio = {
    name: 'E',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'creditOffer',
                maxBorrowAmount: 1000,
                maxCollateralAmount: 25000,
                maxFeeRatePerDay: 0.001,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidCreditOfferRatio, 0, 'test').includes('maxCollateralRatio'),
    'validateBotEntry should require creditOffer.maxCollateralRatio'
);

// Test: valid creditOffer config passes
const validCreditOffer = {
    name: 'F',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'creditOffer',
                outputWeight: 1,
                maxBorrowAmount: 1000,
                maxCollateralAmount: '25%',
                maxFeeRatePerDay: 0.001,
                maxCollateralRatio: 2.5,
                autoReborrow: true,
                renewOnly: true,
            },
        ],
    },
};

assert.strictEqual(
    validateBotEntry(validCreditOffer, 0, 'test'),
    null,
    'validateBotEntry should accept valid creditOffer lending item'
);

const invalidCreditOfferRenewOnly = JSON.parse(JSON.stringify(validCreditOffer));
invalidCreditOfferRenewOnly.debtPolicy.lending[0].renewOnly = 'yes';
assert(
    validateBotEntry(invalidCreditOfferRenewOnly, 0, 'test').includes('renewOnly must be a boolean'),
    'validateBotEntry should reject non-boolean creditOffer renewOnly'
);

// Test: non-positive maxBorrowAmount is rejected
const invalidCreditOfferBorrowCap = {
    name: 'G',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'creditOffer',
                maxBorrowAmount: 0,
                maxCollateralRatio: 2.5,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidCreditOfferBorrowCap, 0, 'test').includes('maxBorrowAmount'),
    'validateBotEntry should reject non-positive maxBorrowAmount'
);

// Test: percentage maxBorrowAmount is rejected
const invalidCreditOfferBorrowPercent = {
    name: 'H',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'creditOffer',
                maxBorrowAmount: '25%',
                maxCollateralRatio: 2.5,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidCreditOfferBorrowPercent, 0, 'test').includes('maxBorrowAmount'),
    'validateBotEntry should reject percentage maxBorrowAmount'
);

// Test: negative maxFeeRatePerDay is rejected
const invalidCreditOfferPerDay = {
    name: 'I',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'creditOffer',
                maxFeeRatePerDay: -0.001,
                maxCollateralRatio: 2.5,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidCreditOfferPerDay, 0, 'test').includes('maxFeeRatePerDay'),
    'validateBotEntry should reject negative maxFeeRatePerDay'
);

// Test: MPA non-positive maxBorrowAmount is rejected
const invalidMpaBorrowCap = {
    name: 'J',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'mpa',
                maxBorrowAmount: 0,
                maxCollateralRatio: 2.5,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidMpaBorrowCap, 0, 'test').includes('maxBorrowAmount'),
    'validateBotEntry should reject non-positive MPA maxBorrowAmount'
);

// Test: MPA minCollateralRatio > maxCollateralRatio is rejected
const invalidMpaCrRange = {
    name: 'J',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'mpa',
                minCollateralRatio: 3.0,
                maxCollateralRatio: 2.0,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidMpaCrRange, 0, 'test').includes('minCollateralRatio'),
    'validateBotEntry should reject minCollateralRatio > maxCollateralRatio'
);

// Test: valid MPA config passes
const validMpa = {
    name: 'K',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        maxCollateralAmount: 10000,
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'mpa',
                outputWeight: 1,
                maxBorrowAmount: 1000,
                maxCollateralAmount: 5000,
                minCollateralRatio: 2.0,
                maxCollateralRatio: 2.5,
                targetCollateralRatio: 2.2,
            },
        ],
    },
};

assert.strictEqual(
    validateBotEntry(validMpa, 0, 'test'),
    null,
    'validateBotEntry should accept valid MPA lending item'
);

// Test: invalid MPA minCollateralIncreaseThreshold is rejected
const invalidMpaMinCollateralIncreaseThreshold = {
    name: 'K2',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                collateralAsset: 'BTS',
                type: 'mpa',
                maxBorrowAmount: 1000,
                minCollateralIncreaseThreshold: -1,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidMpaMinCollateralIncreaseThreshold, 0, 'test').includes('minCollateralIncreaseThreshold'),
    'validateBotEntry should reject negative MPA minCollateralIncreaseThreshold'
);

// Test: invalid creditOffer minCollateralIncreaseThreshold is rejected
const invalidCreditMinCollateralIncreaseThreshold = {
    name: 'K3',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                collateralAsset: 'BTS',
                type: 'creditOffer',
                maxCollateralRatio: 2.5,
                minCollateralIncreaseThreshold: -1,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidCreditMinCollateralIncreaseThreshold, 0, 'test').includes('minCollateralIncreaseThreshold'),
    'validateBotEntry should reject negative creditOffer minCollateralIncreaseThreshold'
);

// Test: percentage minCollateralIncreaseThreshold is accepted
const validPercentMinCollateralIncreaseThreshold = {
    name: 'K4',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                collateralAsset: 'BTS',
                type: 'creditOffer',
                maxCollateralRatio: 2.5,
                minCollateralIncreaseThreshold: '10%',
            },
        ],
    },
};

assert.strictEqual(
    validateBotEntry(validPercentMinCollateralIncreaseThreshold, 0, 'test'),
    null,
    'validateBotEntry should accept percentage minCollateralIncreaseThreshold'
);

// Test: malformed percentage minCollateralIncreaseThreshold is rejected
const invalidPercentMinCollateralIncreaseThreshold = {
    name: 'K5',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                collateralAsset: 'BTS',
                type: 'creditOffer',
                maxCollateralRatio: 2.5,
                minCollateralIncreaseThreshold: '10abc%',
            },
        ],
    },
};

assert(
    validateBotEntry(invalidPercentMinCollateralIncreaseThreshold, 0, 'test').includes('minCollateralIncreaseThreshold'),
    'validateBotEntry should reject malformed percentage minCollateralIncreaseThreshold'
);

// Test: numeric-string minCollateralIncreaseThreshold is rejected
const invalidNumericStringMinCollateralIncreaseThreshold = {
    name: 'K6',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                collateralAsset: 'BTS',
                type: 'mpa',
                maxBorrowAmount: 1000,
                minCollateralIncreaseThreshold: '10',
            },
        ],
    },
};

assert(
    validateBotEntry(invalidNumericStringMinCollateralIncreaseThreshold, 0, 'test').includes('minCollateralIncreaseThreshold'),
    'validateBotEntry should reject numeric-string minCollateralIncreaseThreshold'
);

// Test: null minCollateralIncreaseThreshold is rejected
const invalidNullMinCollateralIncreaseThreshold = {
    name: 'K7',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                collateralAsset: 'BTS',
                type: 'creditOffer',
                maxCollateralRatio: 2.5,
                minCollateralIncreaseThreshold: null,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidNullMinCollateralIncreaseThreshold, 0, 'test').includes('minCollateralIncreaseThreshold'),
    'validateBotEntry should reject null minCollateralIncreaseThreshold'
);

// Test: invalid type is rejected
const invalidType = {
    name: 'L',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            { asset: 'USD',
                    collateralAsset: 'BTS', type: 'invalid', maxCollateralRatio: 2.0 },
        ],
    },
};

assert(
    validateBotEntry(invalidType, 0, 'test').includes("type must be 'mpa' or 'creditOffer'"),
    'validateBotEntry should reject invalid lending type'
);

        // Test: negative outputWeight is rejected
const negativeOutputWeight = {
    name: 'M',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: -1, maxCollateralRatio: 2.0 },
        ],
    },
};

assert(
    validateBotEntry(negativeOutputWeight, 0, 'test').includes('outputWeight'),
    'validateBotEntry should reject negative outputWeight'
);

// Test: legacy ratio field is no longer supported and is rejected
const removedRatio = {
    name: 'N2',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            { asset: 'USD',
                    collateralAsset: 'BTS', type: 'creditOffer', ratio: 2, maxCollateralRatio: 2.5 },
        ],
    },
};

const removedRatioResult = validateBotEntry(removedRatio, 0, 'test');
assert(
    removedRatioResult !== null && removedRatioResult.includes('no longer supported'),
    'validateBotEntry should reject legacy ratio field'
);

// Test: ratio + outputWeight is also rejected (ratio is fully removed)
const removedRatioWithOutputWeight = {
    name: 'N3',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            { asset: 'USD',
                    collateralAsset: 'BTS', type: 'creditOffer', ratio: 1, outputWeight: 1, maxCollateralRatio: 2.5 },
        ],
    },
};

assert(
    validateBotEntry(removedRatioWithOutputWeight, 0, 'test').includes('no longer supported'),
    'validateBotEntry should reject ratio even when outputWeight is present'
);

// Test: global maxCollateralAmount percentage is accepted
const globalMaxCollateralPercent = {
    name: 'N',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        maxCollateralAmount: '80%',
        lending: [
            { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', maxCollateralRatio: 2.0 },
        ],
    },
};

assert.strictEqual(
    validateBotEntry(globalMaxCollateralPercent, 0, 'test'),
    null,
    'validateBotEntry should accept percentage global maxCollateralAmount'
);

// Test: valid MPA debtOnly is accepted
const validMpaDebtOnly = {
    name: 'O',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            { asset: 'USD', collateralAsset: 'BTS', type: 'mpa', debtOnly: true, maxCollateralRatio: 2.0 },
        ],
    },
};

assert.strictEqual(
    validateBotEntry(validMpaDebtOnly, 0, 'test'),
    null,
    'validateBotEntry should accept MPA with debtOnly'
);

// Test: invalid MPA debtOnly non-boolean is rejected
const invalidMpaDebtOnly = {
    name: 'O2',
    assetA: 'BTS',
    assetB: 'USD',
    coreOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            { asset: 'USD', collateralAsset: 'BTS', type: 'mpa', debtOnly: 'yes' },
        ],
    },
};

assert(
    validateBotEntry(invalidMpaDebtOnly, 0, 'test').includes('debtOnly must be a boolean'),
    'validateBotEntry should reject non-boolean MPA debtOnly'
);

// creditOnly: true skips the required-field checks for trading fields
const creditOnlyBot = {
    name: 'Credit',
    active: true,
    creditOnly: true,
    preferredAccount: 'my-account',
    debtPolicy: {
        lending: [
            { asset: 'USD', collateralAsset: 'BTS', type: 'mpa', maxCollateralRatio: 2.0 },
        ],
    },
};
assert.strictEqual(
    validateBotEntry(creditOnlyBot, 0, 'test'),
    null,
    'validateBotEntry should accept creditOnly bot without trading fields'
);

// creditOnly: false (or missing) still requires trading fields
const nonCreditBot = {
    name: 'NoCredit',
    active: true,
};
const result = validateBotEntry(nonCreditBot, 0, 'test');
assert(
    result && result.includes('assetA'),
    'validateBotEntry should require assetA when creditOnly is not set'
);

// edgeOrders: legacy numeric form is accepted (migrated at read time) but
// still must be a non-negative integer.
const baseBot = { name: 'Res', assetA: 'BTS', assetB: 'USD', coreOrders: { sell: 5, buy: 5 }, botFunds: { sell: '100%', buy: '100%' } };
assert.strictEqual(
    validateBotEntry({ ...baseBot, edgeOrders: 2 }, 0, 'test'),
    null,
    'validateBotEntry should accept the legacy numeric edgeOrders form'
);
assert(
    validateBotEntry({ ...baseBot, edgeOrders: 2.5 }, 0, 'test')?.includes('edgeOrders'),
    'validateBotEntry should reject a non-integer legacy numeric edgeOrders'
);
assert(
    validateBotEntry({ ...baseBot, edgeOrders: -1 }, 0, 'test')?.includes('edgeOrders'),
    'validateBotEntry should reject a negative legacy numeric edgeOrders'
);

// Legacy `activeOrders`/`reserveOrders` keys are aliased and validated under
// the canonical names, so a pre-rename bots.json is never rejected.
assert.strictEqual(
    validateBotEntry({ name: 'Legacy', assetA: 'BTS', assetB: 'USD', activeOrders: { sell: 5, buy: 5 }, reserveOrders: 2, botFunds: { sell: '100%', buy: '100%' } }, 0, 'test'),
    null,
    'validateBotEntry should accept legacy activeOrders/reserveOrders keys'
);
assert(
    validateBotEntry({ name: 'LegacyBad', assetA: 'BTS', assetB: 'USD', activeOrders: { sell: 5, buy: 5 }, reserveOrders: -1, botFunds: { sell: '100%', buy: '100%' } }, 0, 'test')?.includes('edgeOrders'),
    'validateBotEntry should reject a negative legacy reserveOrders value'
);

// loadSettingsFile upgrades a pre-rename bots.json on disk: legacy keys are
// rewritten to the canonical names so user settings migrate transparently.
{
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-bots-migrate-'));
    const botsPath = path.join(tmpDir, 'bots.json');
    fs.writeFileSync(botsPath, JSON.stringify({
        bots: [{
            name: 'Old', assetA: 'BTS', assetB: 'USD',
            activeOrders: { sell: 5, buy: 5 },
            reserveOrders: 2,
            botFunds: { sell: '100%', buy: '100%' },
        }],
    }, null, 2));
    loadSettingsFile(botsPath, { silent: true });
    const onDisk = JSON.parse(fs.readFileSync(botsPath, 'utf8'));
    assert.deepStrictEqual(onDisk.bots[0].coreOrders, { sell: 5, buy: 5 }, 'loadSettingsFile must persist coreOrders');
    assert.strictEqual(onDisk.bots[0].edgeOrders, 2, 'loadSettingsFile must persist edgeOrders');
    assert.ok(!('activeOrders' in onDisk.bots[0]), 'activeOrders must be removed from disk');
    assert.ok(!('reserveOrders' in onDisk.bots[0]), 'reserveOrders must be removed from disk');
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Cross-bot guard: two active bots on one account AND one market would keep
// independent grids over the same chain orders. Different markets and inactive
// bots on the same account/market stay valid.
{
    const marketBot = (name: string, account: string, assetA: string, assetB: string, active = true) => ({
        name, active, preferredAccount: account, assetA, assetB,
        coreOrders: { sell: 5, buy: 5 }, botFunds: { sell: '100%', buy: '100%' },
    });
    const sameMarket = collectValidationIssues([
        marketBot('GRID-A', 'account-one', 'BTS', 'USD'),
        marketBot('GRID-B', 'account-one', 'usd', 'bts'),
    ], 'test');
    assert.ok(
        sameMarket.errors.some((e: string) => e.includes('both trade account') && e.includes('BTS/USD')),
        'collectValidationIssues must reject two active bots on the same account and market (order-insensitive)'
    );

    const differentMarkets = collectValidationIssues([
        marketBot('GRID-A', 'account-one', 'BTS', 'USD'),
        marketBot('GRID-B', 'account-one', 'BTS', 'TKN'),
    ], 'test');
    assert.ok(
        !differentMarkets.errors.some((e: string) => e.includes('both trade account')),
        'different markets on the same account are allowed'
    );

    const inactiveSibling = collectValidationIssues([
        marketBot('GRID-A', 'account-one', 'BTS', 'USD'),
        marketBot('GRID-B', 'account-one', 'BTS', 'USD', false),
    ], 'test');
    assert.ok(
        !inactiveSibling.errors.some((e: string) => e.includes('both trade account')),
        'an inactive bot does not create a duplicate-market conflict'
    );

    const dryRunSibling = collectValidationIssues([
        marketBot('GRID-A', 'account-one', 'BTS', 'USD'),
        { ...marketBot('GRID-B', 'account-one', 'BTS', 'USD'), dryRun: true },
    ], 'test');
    assert.ok(
        !dryRunSibling.errors.some((e: string) => e.includes('both trade account')),
        'a dry-run copy places no orders and does not create a duplicate-market conflict'
    );
}

console.log('bot settings tests passed');
process.exit(0);
