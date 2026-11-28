const assert = require('assert');

console.log('Running tradingview chart storage-key tests');

const {
    generateHTML,
    resolveChartStorageKey,
    sanitizeStorageComponent,
    TRADINGVIEW_PREFS_KEY_PREFIX,
    TRADINGVIEW_SYNC_KEY,
} = require('../analysis/tradingview/tradingview_uplot_chart_generator');
const { MARKET_ADAPTER } = require('../modules/constants');

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
    try {
        fn();
        passed++;
    } catch (err: any) {
        failed++;
        console.error(`  FAIL: ${name}`);
        console.error(`    ${err && err.message ? err.message : err}`);
        if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
}

// ── sanitizeStorageComponent ──────────────────────────────────────
check('sanitize: primitives are preserved', () => {
    assert.strictEqual(sanitizeStorageComponent('1.19.133', 'x'), '1.19.133');
    assert.strictEqual(sanitizeStorageComponent(305, 'x'), '305');
});

check('sanitize: whitespace and punctuation collapse to underscores', () => {
    assert.strictEqual(sanitizeStorageComponent('  IOB XRP!!  ', 'x'), 'IOB_XRP');
    // Dashes and dots are valid in storage keys and are preserved.
    assert.strictEqual(sanitizeStorageComponent('1.19.133', 'x'), '1.19.133');
    assert.strictEqual(sanitizeStorageComponent('-a-b-', 'x'), '-a-b-');
});

check('sanitize: empty/null uses fallback', () => {
    assert.strictEqual(sanitizeStorageComponent(null, 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent(undefined, 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent('', 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent('   ', 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent('!!!', 'fb'), 'fb');
});

check('sanitize: plain objects use fallback (not "[object Object]")', () => {
    assert.strictEqual(sanitizeStorageComponent({}, 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent({ symbol: undefined, id: null }, 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent([], 'fb'), 'fb');
});

// ── resolveChartStorageKey ────────────────────────────────────────
check('key: namespaced prefix and sync constant', () => {
    assert.strictEqual(TRADINGVIEW_PREFS_KEY_PREFIX, 'dexbot2-tradingview-uplot-v3');
    assert.strictEqual(TRADINGVIEW_SYNC_KEY, 'dexbot2-tradingview-sync');
});

check('key: distinct per pool and pair, stable across calls', () => {
    const pairA = { pool: '1.19.133', assetA: { id: '1.3.5537', symbol: 'IOB.XRP' }, assetB: { id: '1.3.0', symbol: 'BTS' } };
    const pairB = { pool: '1.19.305', assetA: { id: '1.3.0', symbol: 'BTS' }, assetB: { id: '1.3.121', symbol: 'HONEST' } };
    const a1 = resolveChartStorageKey(pairA, 3600);
    const a2 = resolveChartStorageKey(pairA, 3600);
    const b = resolveChartStorageKey(pairB, 3600);
    assert.strictEqual(a1, a2);
    assert.notStrictEqual(a1, b);
    assert.strictEqual(a1, 'dexbot2-tradingview-uplot-v3:1.19.133:1.3.5537_1.3.0:3600');
});

check('key: same pair in different pools stays distinct', () => {
    const pair = { assetA: { id: '1.3.5537' }, assetB: { id: '1.3.0' } };
    const a = resolveChartStorageKey({ ...pair, pool: '1.19.133' }, 3600);
    const b = resolveChartStorageKey({ ...pair, pool: '1.19.305' }, 3600);
    assert.notStrictEqual(a, b);
});

check('key: interval participates in the key', () => {
    const meta = { assetA: { id: '1.3.0' }, assetB: { id: '1.3.121' } };
    assert.notStrictEqual(resolveChartStorageKey(meta, 3600), resolveChartStorageKey(meta, 14400));
});

check('key: non-positive/absent interval falls back to literal "base"', () => {
    const meta = { assetA: { id: '1.3.0' }, assetB: { id: '1.3.121' } };
    assert.ok(resolveChartStorageKey(meta, 0).endsWith(':base'));
    assert.ok(resolveChartStorageKey(meta, undefined).endsWith(':base'));
    assert.ok(resolveChartStorageKey(meta, -5).endsWith(':base'));
});

check('key: string assets and poolId alias are accepted', () => {
    const key = resolveChartStorageKey({ poolId: '1.19.9', assetA: 'BTS', assetB: 'HONEST' }, 3600);
    assert.strictEqual(key, 'dexbot2-tradingview-uplot-v3:1.19.9:BTS_HONEST:3600');
});

check('key: symbol used when id is absent', () => {
    const key = resolveChartStorageKey({ assetA: { symbol: 'IOB.XRP' }, assetB: { symbol: 'BTS' } }, 3600);
    assert.strictEqual(key, 'dexbot2-tradingview-uplot-v3:nipool:IOB.XRP_BTS:3600');
});

check('key: object asset without id/symbol uses fallback, not "object_Object"', () => {
    const key = resolveChartStorageKey({ assetA: {}, assetB: {} }, 3600);
    assert.strictEqual(key, 'dexbot2-tradingview-uplot-v3:nipool:assetA_assetB:3600');
});

check('key: empty meta produces a valid default key', () => {
    assert.strictEqual(resolveChartStorageKey(), 'dexbot2-tradingview-uplot-v3:nipool:assetA_assetB:base');
});

// ── Simulated band price-axis fit ─────────────────────────────────
check('fit: simulated band extension tracks the upper edge with max', () => {
    const html = generateHTML({
        candles: [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710007200000, 1.08, 1.22, 1.01, 1.15, 9],
        ],
        meta: { assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
        grid: { minPrice: '1.5x', maxPrice: '3x' },
        gridSim: { enabled: true, priceDeltaThresholdPercent: 1, slopeDeltaThresholdPercent: 0.0072, slopeEnabled: true },
    });
    assert.ok(html.includes('if (su > simMax) simMax = su;'), 'simMax must track the band upper bound');
    assert.ok(!html.includes('if (su < simMax) simMax = su;'), 'inverted simMax comparison must not return');
    assert.ok(html.includes('SIM_FIT_MAX_STRETCH'), 'the stretch guard must stay wired');
});

// ── Shared AMA-slope lookback window ──────────────────────────────
check('slope window: the band and the reset replay resolve one shared lookback', () => {
    const html = generateHTML({
        candles: [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710007200000, 1.08, 1.22, 1.01, 1.15, 9],
        ],
        meta: { assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
        gridSim: { enabled: true, lookbackBars: 32 },
    });
    assert.ok(html.includes('function resolveSlopeLookbackBars()'), 'the shared resolver must exist');
    assert.ok(
        html.includes('const lookback = resolveSlopeLookbackBars();'),
        'the range band must consume the shared resolver',
    );
    assert.ok(
        !html.includes('slopeCfg.lookbackBars'),
        'the band must not stay pinned to the constant while the replay uses the config',
    );
    assert.ok(
        /Object\.assign\(\{\}, gridSimCfg, \{[\s\S]*?warmupBars: warmupBars,/.test(html),
        'the replay must still derive warmupBars from gridSimCfg',
    );
    assert.ok(
        !/Object\.assign\(\{\}, gridSimCfg, \{[^}]*lookbackBars:/.test(html),
        'the replay must keep its own already-resolved lookbackBars, never an override',
    );
    assert.ok(
        html.includes('slopeEstimator: resolveChartSlopeEstimator()'),
        'the replay must average with the same model as the band',
    );
});

check('slope window: a bot-configured lookback reaches the band through the payload', () => {
    const html = generateHTML({
        candles: [[1710000000000, 1, 1.1, 0.9, 1.02, 10]],
        meta: { assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
        gridSim: { enabled: true, lookbackBars: 32 },
    });
    const payload = JSON.parse(/<script id="payload"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]);
    assert.strictEqual(payload.gridSim.lookbackBars, 32, 'the config-resolved window must reach the page');
    assert.strictEqual(
        payload.rangeSlope.lookbackBars,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        'the constant stays embedded as the fallback',
    );
});

// ── Chart slope estimator (must match the runtime) ────────────────
check('slope model: the page uses the canonical Huber -> EMA series for both consumers', () => {
    const html = generateHTML({
        candles: [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710007200000, 1.08, 1.22, 1.01, 1.15, 9],
        ],
        meta: { assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
    });
    assert.ok(html.includes("const CHART_SLOPE_ESTIMATOR = 'canonical'"), 'the chart must default to the runtime estimator');
    assert.ok(
        html.includes(`const AMA_SLOPE_HUBER = ${JSON.stringify(MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER)};`),
        'the centralized Huber params must be injected verbatim from constants',
    );
    assert.ok(
        html.includes('function computeHuberWindowSlopePct'),
        'the canonical estimator must be embedded (one definition, shared with the runtime)',
    );
    assert.ok(
        html.includes('function resolveChartSlopeEstimator()'),
        'one resolver must select the estimator for band and replay',
    );
    assert.ok(
        html.includes('function computeAmaSlopeEmaSeries('),
        'the canonical Huber -> EMA helper must be embedded',
    );
    assert.ok(
        html.includes('bandSlopeSeries[i]'),
        'the band must read the shared shaped slope series',
    );
    assert.ok(
        html.includes('emaAlpha: resolveSlopeEmaAlpha()'),
        'the replay must receive the same resolved alpha as the band',
    );
    assert.ok(
        html.includes('return computeHuberWindowSlopePct;'),
        'the default branch must be the canonical Huber estimator',
    );
    assert.ok(
        !html.includes('function computeMedianSlopeClipThreshold'),
        'the chart must not carry its own clip helper: the canonical clip now measures the estimator',
    );
    assert.ok(
        html.includes('slopeEstimator: resolveChartSlopeEstimator()'),
        'the replay must average with the same model as the band',
    );
});

check('slope model: the embedded estimator executes against the injected constants', () => {
    // Guards the one runtime coupling the string checks cannot see: the embedded
    // computeHuberWindowSlopePct defaults `hub` to AMA_SLOPE_HUBER, so the page
    // must declare that const or the estimator throws a ReferenceError.
    const html = generateHTML({
        candles: [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710007200000, 1.08, 1.22, 1.01, 1.15, 9],
        ],
        meta: { assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
    });
    const constMatch = /const AMA_SLOPE_HUBER = (\{[^;]*\});/.exec(html);
    const fnMatch = /function computeHuberWindowSlopePct\([\s\S]*?\n\}/.exec(html);
    assert.ok(constMatch && fnMatch, 'both the const and the estimator must be embedded');
    const embedded = new Function(`const AMA_SLOPE_HUBER = ${constMatch![1]}; ${fnMatch![0]}; return computeHuberWindowSlopePct;`)();
    const { computeHuberWindowSlopePct } = require('../market_adapter/core/strategies/dynamic_weight_series');
    const ramp: number[] = [];
    for (let i = 0; i < 60; i++) ramp.push(100 * Math.pow(1.003, i));
    assert.strictEqual(embedded(ramp, 59, 20), computeHuberWindowSlopePct(ramp, 59, 20),
        'the browser-embedded estimator must produce the same value as the Node module');
});

check('slope model: the embedded EMA helper matches the Node module', () => {
    const html = generateHTML({
        candles: [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710007200000, 1.08, 1.22, 1.01, 1.15, 9],
        ],
        meta: { assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
    });
    const hub = /const AMA_SLOPE_HUBER = (\{[^;]*\});/.exec(html);
    const hubFn = /function computeHuberWindowSlopePct\([\s\S]*?\n\}/.exec(html);
    const emaFn = /function computeAmaSlopeEmaSeries\([\s\S]*?\n\}/.exec(html);
    assert.ok(hub && hubFn && emaFn, 'both slope functions and the Huber const must be embedded');
    const embedded = new Function(`const AMA_SLOPE_HUBER = ${hub![1]}; ${hubFn![0]}\n${emaFn![0]}; return computeAmaSlopeEmaSeries;`)();
    const { computeAmaSlopeEmaSeries } = require('../market_adapter/core/strategies/dynamic_weight_series');
    const ramp: number[] = [];
    for (let i = 0; i < 80; i++) ramp.push(100 * Math.pow(1.003, i) * (i === 55 ? 1.02 : 1));
    for (const alpha of [1, 0.2]) {
        assert.deepStrictEqual(
            embedded(ramp, 10, 8, alpha),
            computeAmaSlopeEmaSeries(ramp, 10, 8, alpha),
            `browser-embedded EMA helper must match Node for alpha ${alpha}`
        );
    }
});

check('slope model: chart alpha resolver clamps to the centralized bounds', () => {
    const html = generateHTML({
        candles: [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710007200000, 1.08, 1.22, 1.01, 1.15, 9],
        ],
        meta: { assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
    });
    const expectedBounds = JSON.stringify({
        MIN: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA_MIN,
        MAX: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA_MAX,
    });
    assert.ok(
        html.includes(`const GRID_SIM_EMA_ALPHA_BOUNDS = ${expectedBounds};`),
        'the page must inject the same bounds the embedded replay reads'
    );
    const boundsMatch = /const GRID_SIM_EMA_ALPHA_BOUNDS = (\{[^;]*\});/.exec(html);
    const resolverMatch = /function resolveSlopeEmaAlpha\(\) \{[\s\S]*?\n        \}/.exec(html);
    assert.ok(boundsMatch && resolverMatch, 'bounds const and alpha resolver must be embedded');
    // Evaluate the real page resolver with controlled config sources so an
    // unnormalized payload cannot silently diverge from the runtime's clamp.
    const resolve = new Function('gridSimCfg', 'payload',
        `const GRID_SIM_EMA_ALPHA_BOUNDS = ${boundsMatch![1]}; ${resolverMatch![0]}; return resolveSlopeEmaAlpha();`);
    const min = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA_MIN;
    const max = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA_MAX;
    assert.strictEqual(resolve(null, { rangeSlope: { emaAlpha: 0.01 } }), min,
        'an unnormalized low alpha must be clamped up to the live minimum');
    assert.strictEqual(resolve({ emaAlpha: 2 }, {}), max,
        'an out-of-range high alpha must be clamped down to the live maximum');
    assert.strictEqual(resolve({ emaAlpha: 0.2 }, {}), 0.2, 'a valid alpha must pass through unchanged');
    assert.strictEqual(resolve(null, {}), MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA,
        'a missing alpha must fall back to the centralized default');

    // The embedded replay now reads GRID_SIM_EMA_ALPHA_BOUNDS at call time;
    // execute the whole embedded block to catch a broken injection/reference.
    const hubMatch = /const AMA_SLOPE_HUBER = (\{[^;]*\});/.exec(html);
    const startMarker = '/* EMBEDDED_FUNCS_START */';
    const endMarker = '/* EMBEDDED_FUNCS_END */';
    const start = html.indexOf(startMarker);
    const end = html.indexOf(endMarker);
    assert.ok(hubMatch && start >= 0 && end > start, 'the embedded block and Huber const must be present');
    const resetConsts = ['NONE', 'BOOTSTRAP', 'PRICE', 'SLOPE']
        .map((name) => new RegExp(`const GRID_RESET_${name} = (\\d+);`).exec(html)?.[0] ?? '')
        .join('\n');
    const embeddedSim = new Function(
        `const AMA_SLOPE_HUBER = ${hubMatch![1]}; const GRID_SIM_EMA_ALPHA_BOUNDS = ${boundsMatch![1]};\n${resetConsts}\n`
        + `function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }\n`
        + `${html.slice(start + startMarker.length, end)}; return simulateGridResetSeries;`
    )();
    const { simulateGridResetSeries } = require('../analysis/tradingview/grid_reset_sim');
    const simCfg = {
        priceDeltaThresholdPercent: 0, slopeDeltaThresholdPercent: 0.01, slopeEnabled: true,
        erPeriod: 1, lookbackBars: 1, warmupBars: 2, maxSlopePct: 0.09,
        neutralZonePct: 0, maxSlopeOffset: 0.5, clipPercentile: 0,
        clampMin: null, clampMax: null, emaAlpha: 0.001,
    };
    const ama: number[] = [];
    for (let i = 0; i < 30; i++) ama.push(100 * Math.pow(1.001, i));
    assert.deepStrictEqual(embeddedSim(ama, simCfg), simulateGridResetSeries(ama, simCfg),
        'browser-embedded replay must clamp alpha like the Node module');
});

check('slope model: the sim default is the canonical estimator, and the hook still overrides', () => {
    // The seam exists only so the chart can render the reference two-point
    // definition for comparison; with no hook the replay must match the runtime.
    const { computeAverageAmaSlopePct, computeHuberWindowSlopePct, computeAmaSlopeEmaSeries } = require('../market_adapter/core/strategies/dynamic_weight_series');
    const { simulateGridResetSeries } = require('../analysis/tradingview/grid_reset_sim');
    const ama: (number | null)[] = [];
    for (let i = 0; i < 300; i++) {
        ama.push(i % 37 === 0 ? null : 1 + 0.02 * Math.sin(i / 9) + 0.0003 * i);
    }
    const cfg = {
        priceDeltaThresholdPercent: 0, slopeDeltaThresholdPercent: 0.0072, slopeEnabled: true,
        erPeriod: 24, lookbackBars: 20, warmupBars: 44, maxSlopePct: 0.09,
        neutralZonePct: 0, maxSlopeOffset: 0.5, clipPercentile: 10, clampMin: null, clampMax: null,
    };
    const plain = simulateGridResetSeries(ama, cfg);
    const readyBars = Math.ceil(cfg.erPeriod) + cfg.lookbackBars;
    // Mirror the replay's own guards (warmup floor + a usable current value);
    // `Number(null) === 0`, so a pre-warmup hole must not be read as a price.
    const hasAma = (i: number) => {
        const v = Number(ama[i]);
        return Number.isFinite(v) && v > 0;
    };
    const huberAt = (i: number) => (i < readyBars || !hasAma(i) ? null : computeHuberWindowSlopePct(ama, i, cfg.lookbackBars));
    const endpointAt = (i: number) => {
        const past = Number(ama[i - cfg.lookbackBars]);
        if (i < readyBars || !hasAma(i) || !Number.isFinite(past) || past === 0) return null;
        return computeAverageAmaSlopePct(Number(ama[i]), past, cfg.lookbackBars);
    };

    // No cfg.slopeEstimator must mean exactly what the live adapter computes.
    assert.deepStrictEqual(plain.slopePct, ama.map((_, i) => huberAt(i)),
        'with EMA off the replay default must be the canonical Huber slope, bar for bar');
    // Production alpha: the replay must equal the canonical EMA helper exactly.
    const shaped = simulateGridResetSeries(ama, { ...cfg, emaAlpha: 0.2 });
    assert.deepStrictEqual(
        shaped.slopePct,
        computeAmaSlopeEmaSeries(ama, cfg.erPeriod, cfg.lookbackBars, 0.2),
        'the replay with EMA on must match the shared canonical slope series'
    );
    // An explicit hook still overrides, which is what the chart's 'endpoint'
    // comparison mode relies on.
    const viaHook = simulateGridResetSeries(ama, {
        ...cfg,
        slopeEstimator: (series: any, i: number, lb: number) =>
            computeAverageAmaSlopePct(Number(series[i]), Number(series[i - lb]), lb),
    });
    assert.deepStrictEqual(viaHook.slopePct, ama.map((_, i) => endpointAt(i)),
        'the endpoint hook must reproduce the reference definition');
    assert.notDeepStrictEqual(viaHook.slopePct, plain.slopePct,
        'the hook must actually change the estimator');
});

// ── Timeframe buttons ─────────────────────────────────────────────
check('timeframes: the 1h option is present and resolves as default on an hourly base', () => {
    const html = generateHTML({
        candles: [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710007200000, 1.08, 1.22, 1.01, 1.15, 9],
        ],
        meta: { assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
        defaultTimeframe: '1h',
    });
    const payload = JSON.parse(/<script id="payload"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]);
    const oneHour = payload.timeframes.find((tf: { label: string; seconds: number; enabled: boolean }) => tf.label === '1h');
    assert.ok(oneHour, 'the 1h timeframe must be embedded');
    assert.strictEqual(oneHour.seconds, 3600);
    assert.strictEqual(oneHour.enabled, true, '1h must be selectable on a 1h base');
    assert.strictEqual(payload.defaultTimeframe, '1h', '1h must resolve as the default, not fall through to 4h');
    assert.ok(html.includes('data-timeframe="1h"'), 'the 1h button must be rendered');
});

check('timeframes: 1h is disabled when the base is coarser than an hour', () => {
    const html = generateHTML({
        candles: [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710014400000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710028800000, 1.08, 1.22, 1.01, 1.15, 9],
        ],
        meta: { intervalSeconds: 14400, assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
        defaultTimeframe: '1h',
    });
    const payload = JSON.parse(/<script id="payload"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]);
    const oneHour = payload.timeframes.find((tf: { label: string; seconds: number; enabled: boolean }) => tf.label === '1h');
    assert.ok(oneHour && oneHour.enabled === false, '1h must not be offered below the base interval');
});

if (failed > 0) {
    console.error(`tradingview chart storage-key tests FAILED: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`tradingview chart storage-key tests passed (${passed} checks)`);
