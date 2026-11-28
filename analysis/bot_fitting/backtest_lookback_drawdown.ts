'use strict';

/**
 * LOOKBACK → FILL-MODEL DRAWDOWN BACKTEST
 *
 * Runs the persistent-grid simulation (`simulatePersistentGrid`, shared with
 * `backtest_ama_sweep`) across a set of Huber slope lookbacks over ONE geometry
 * grid, so the lookback's effect on realized drawdown / net capture / reset
 * churn is compared with geometry held fixed. Every
 * (spread, increment, ratio, weight) combo is run once per lookback and matched
 * by key, so the comparison is PAIRED — the delta isolates the window, not the
 * strategy shape.
 *
 * Why this exists (see docs/AMA_SLOPE_WINDOW.md): the signal-side window metrics
 * (wobble / lag / wrong-way) are second-order, so the open question is whether
 * the window moves the fill-model economics. It does, but the SIGN IS
 * POOL-DEPENDENT — on a long-lived liquid pair a 16h window beat 12h on both
 * drawdown and net capture across 100% of geometries, while on a shorter pair
 * the ordering reversed. Treat the paired delta, never the absolute level (the
 * realized-equity drawdown here is model-shaped and can exceed capital), and
 * re-run per pool before drawing a conclusion.
 *
 * Trigger B (slope-delta reset) and the slope-ratio grid offset only act under
 * the production asymmetricBounds whitelist, so the lookback has no effect
 * unless `--asymmetric-bounds` is on — it defaults ON here, since a lookback
 * comparison is the whole point. Pass `--no-asymmetric-bounds` for the
 * non-whitelisted path (where the result collapses to lookback-independent).
 *
 * Usage:
 *   node dist/analysis/bot_fitting/backtest_lookback_drawdown.js \
 *     --data market_adapter/data/lp/<market-pair> --lookbacks 12,14,16,20
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateAMA, getAmaWarmupBars } from '../../market_adapter/core/strategies/ama.js';
import { parseListOrRange } from './shared_utils.js';
import { printHelpHeader, helpRow } from '../analyze_args.js';
import { median, percentile, fmtNum as fmt, loadCandleSeries } from '../math_utils.js';
import { simulatePersistentGrid, WEIGHT_PROFILES } from './backtest_ama_sweep.js';
import { getStorage } from '../../modules/storage/index.js';
import { PATHS } from '../../modules/paths.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';

const { writeJSON } = getStorage();
const MA = MARKET_ADAPTER;

// A modest geometry grid — enough spread/increment/ratio variety to keep the
// paired comparison honest without the full sweep's cost. Override per run.
const DEFAULT_SPREADS = [1, 2, 3, 4];
const DEFAULT_INCREMENTS = [0.5, 1, 2];
const DEFAULT_RATIOS = [1.2, 2, 5];
const DEFAULT_LOOKBACKS = [12, 14, 16, 20];
// The shipped default window — the reference for the paired delta table.
const REFERENCE_LOOKBACK = MA.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;

function parseArgs() {
    const args = process.argv.slice(2);
    const out = {
        dataPath: '' as string,
        amaName: MA.DEFAULT_AMA_KEY as string,
        lookbacks: [...DEFAULT_LOOKBACKS],
        spreads: [...DEFAULT_SPREADS],
        increments: [...DEFAULT_INCREMENTS],
        ratios: [...DEFAULT_RATIOS],
        maxOrders: 20,
        feeRoundtripPct: 0.20,
        capital: 10000,
        repositionPct: MA.AMA_DELTA_THRESHOLD_PERCENT,
        asymmetricBounds: true,
        btsCreateFee: 0.4826,
        btsCancelFee: 0.00482,
        makerCreateFactor: 0.10,
        txFeePrice: 1.0,
        outPath: null as string | null,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
        if (arg === '--asymmetric-bounds') { out.asymmetricBounds = true; continue; }
        if (arg === '--no-asymmetric-bounds') { out.asymmetricBounds = false; continue; }
        const val = args[i + 1];
        if (!val) continue;
        switch (arg) {
            case '--data': out.dataPath = val; i++; break;
            case '--ama': out.amaName = val; i++; break;
            case '--lookbacks': out.lookbacks = parseListOrRange(val, out.lookbacks).map((v: number) => Math.round(v)); i++; break;
            case '--spread': out.spreads = parseListOrRange(val, out.spreads); i++; break;
            case '--increment': out.increments = parseListOrRange(val, out.increments); i++; break;
            case '--ratio': out.ratios = parseListOrRange(val, out.ratios); i++; break;
            case '--max-orders': out.maxOrders = Number(val); i++; break;
            case '--fee': out.feeRoundtripPct = Number(val); i++; break;
            case '--capital': out.capital = Number(val); i++; break;
            case '--reposition': out.repositionPct = Number(val); i++; break;
            case '--bts-create-fee': out.btsCreateFee = Number(val); i++; break;
            case '--bts-cancel-fee': out.btsCancelFee = Number(val); i++; break;
            case '--maker-create-factor': out.makerCreateFactor = Number(val); i++; break;
            case '--tx-fee-price': out.txFeePrice = Number(val); i++; break;
            case '--out': out.outPath = path.resolve(val); i++; break;
        }
    }
    if (!out.dataPath) throw new Error('--data <path-to-lp-candles.json|dir> is required');
    out.lookbacks = [...new Set(out.lookbacks)].filter((v) => Number.isFinite(v) && v >= 2).sort((a, b) => a - b);
    if (out.lookbacks.length === 0) throw new Error('--lookbacks must resolve to a non-empty list of bars >= 2');
    return out;
}

function printHelp() {
    printHelpHeader('Lookback -> fill-model drawdown backtest (paired persistent-grid simulation)', 'bot_fitting/backtest_lookback_drawdown.js');
    console.log(helpRow('--data <path>', 'LP candle file or shard directory (required)', 25));
    console.log(helpRow('--ama <AMA1..AMA4>', `Built-in AMA preset (default: ${MA.DEFAULT_AMA_KEY})`, 25));
    console.log(helpRow('--lookbacks <spec>', `Lookbacks to compare: 12,14,16,20 (default: ${DEFAULT_LOOKBACKS.join(',')})`, 25));
    console.log(helpRow('--spread <spec>', `Spread grid (default: ${DEFAULT_SPREADS.join(',')})`, 25));
    console.log(helpRow('--increment <spec>', `Increment grid (default: ${DEFAULT_INCREMENTS.join(',')})`, 25));
    console.log(helpRow('--ratio <spec>', `Max/min ratio grid (default: ${DEFAULT_RATIOS.join(',')})`, 25));
    console.log(helpRow('--max-orders <n>', 'Size cap per side (default: 20)', 25));
    console.log(helpRow('--fee <pct>', 'Round-trip fee % (default: 0.20)', 25));
    console.log(helpRow('--capital <n>', 'Notional capital per side (default: 10000)', 25));
    console.log(helpRow('--reposition <pct>', `AMA drift % to re-center (default: ${MA.AMA_DELTA_THRESHOLD_PERCENT})`, 25));
    console.log(helpRow('--no-asymmetric-bounds', 'Disable trigger B + slope offset (default: enabled)', 25));
    console.log(helpRow('--out <path>', 'JSON output path', 25));
}

function resolveAma(name: string) {
    const presets = MA.AMAS as Record<string, { erPeriod: number; fastPeriod: number; slowPeriod: number }>;
    const preset = presets[name];
    if (!preset) throw new Error(`Unknown AMA preset '${name}' (expected ${Object.keys(presets).join(', ')})`);
    return { name, er: preset.erPeriod, fast: preset.fastPeriod, slow: preset.slowPeriod };
}

function run() {
    const cfg = parseArgs();
    const amaDef = resolveAma(cfg.amaName);
    const { candles, files } = loadCandleSeries(cfg.dataPath);
    const closes = candles.map((c) => c.close);
    const amaValues = calculateAMA(closes, { erPeriod: amaDef.er, fastPeriod: amaDef.fast, slowPeriod: amaDef.slow });
    const warmupBars = getAmaWarmupBars(amaDef.er, amaDef.slow, 0, amaDef.fast);

    const weightEntries = Object.entries(WEIGHT_PROFILES);
    interface Combo {
        spreadPct: number;
        incrementPct: number;
        maxMinRatio: number;
        weightName: string;
        weightFactor: number;
    }
    const combos: Combo[] = [];
    for (const spreadPct of cfg.spreads)
        for (const incrementPct of cfg.increments)
            for (const maxMinRatio of cfg.ratios)
                for (const [weightName, weightFactor] of weightEntries)
                    combos.push({ spreadPct, incrementPct, maxMinRatio, weightName, weightFactor });

    console.log('================================================================================');
    console.log(' LOOKBACK -> FILL-MODEL DRAWDOWN (paired persistent-grid simulation)');
    console.log('================================================================================');
    console.log(`  Data:       ${path.resolve(cfg.dataPath)} (${files} file(s), ${candles.length} candles)`);
    console.log(`  AMA:        ${amaDef.name} (er=${amaDef.er}, fast=${amaDef.fast}, slow=${amaDef.slow}), warmup ${warmupBars} bars`);
    console.log(`  Lookbacks:  ${cfg.lookbacks.join(', ')} bars  |  geometries: ${combos.length}`);
    console.log(`  Bounds:     asymmetricBounds ${cfg.asymmetricBounds ? 'ON (trigger B + slope offset active)' : 'OFF (lookback-independent)'}`);
    console.log(`  Reference:  ${REFERENCE_LOOKBACK}h (shipped default) for the paired delta\n`);

    const byLookback: Record<number, Record<string, ReturnType<typeof simulatePersistentGrid>>> = {};
    for (const lb of cfg.lookbacks) {
        const perGeom: Record<string, ReturnType<typeof simulatePersistentGrid>> = {};
        for (const c of combos) {
            const sim = simulatePersistentGrid(candles, amaValues, {
                spreadPct: c.spreadPct,
                incrementPct: c.incrementPct / 100,
                maxMinRatio: c.maxMinRatio,
                maxOrders: cfg.maxOrders,
                feeRoundtripPct: cfg.feeRoundtripPct,
                capital: cfg.capital,
                repositionThreshold: cfg.repositionPct / 100,
                asymmetricBounds: cfg.asymmetricBounds,
                btsCreateFee: cfg.btsCreateFee,
                btsCancelFee: cfg.btsCancelFee,
                makerCreateFactor: cfg.makerCreateFactor,
                txFeePrice: cfg.txFeePrice,
                warmupBars,
                // Mirror the other two callers: seed the EMA at ceil(er)+lb so
                // the trigger-B slope uses the live readiness guard.
                erPeriod: amaDef.er,
                lookbackBars: lb,
            }, c.weightName, c.weightFactor);
            perGeom[`${c.spreadPct}|${c.incrementPct}|${c.maxMinRatio}|${c.weightName}`] = sim;
        }
        byLookback[lb] = perGeom;
        process.stdout.write(`  lb=${String(lb).padStart(2)}  done (${combos.length} geometries)\n`);
    }

    // Paired keys: geometries with fills under EVERY lookback.
    const ref = byLookback[REFERENCE_LOOKBACK] ?? byLookback[cfg.lookbacks[0]];
    const keys = Object.keys(ref).filter((k) => cfg.lookbacks.every((lb) => byLookback[lb][k]?.matchedPairs > 0));

    console.log('\n================================================================================');
    console.log(' PER-LOOKBACK MEDIANS (over paired geometries)');
    console.log('================================================================================');
    const fields: Array<[string, string, number, number]> = [
        ['maxDrawdown %', 'maxDrawdownPct', 1, 2],
        ['netProfit / capital %', 'netProfitPerCapital', 100, 2],
        ['pairs / day', 'pairsPerDay', 1, 2],
        ['repositions', 'repositionCount', 1, 0],
        ['slope-trigger resets', 'slopeTriggerCount', 1, 0],
        ['maxInventoryExposure', 'maxInventoryExposure', 1, 0],
    ];
    console.log('  lb |' + cfg.lookbacks.map((lb) => String(lb).padStart(12)).join(''));
    console.log('  ---+' + cfg.lookbacks.map(() => '------------').join(''));
    for (const [label, field, mul, d] of fields) {
        let row = `  ${label.padEnd(20).slice(0, 20)} |`;
        for (const lb of cfg.lookbacks) {
            row += fmt(median(keys.map((k) => (byLookback[lb][k] as unknown as Record<string, number>)[field] * mul)) ?? Number.NaN, d).padStart(12);
        }
        console.log(row);
    }

    console.log('\n================================================================================');
    console.log(` PAIRED DELTA vs ${REFERENCE_LOOKBACK}h (max drawdown) — negative = lower DD than reference`);
    console.log('================================================================================');
    console.log('  lb | median delta | p25 .. p75 | lower-DD geometries');
    for (const lb of cfg.lookbacks) {
        const deltas = keys.map((k) => byLookback[lb][k].maxDrawdownPct - ref[k].maxDrawdownPct);
        const lower = deltas.filter((d) => d < 0).length;
        console.log(
            `  ${String(lb).padStart(2)} | ` +
            `${fmt(median(deltas) ?? Number.NaN).padStart(12)} | ` +
            `${fmt(percentile(deltas, 25, { interpolation: 'nearest', rounding: 'floor', empty: Number.NaN }))} .. ${fmt(percentile(deltas, 75, { interpolation: 'nearest', rounding: 'floor', empty: Number.NaN }))} | ` +
            `${lower}/${deltas.length} (${fmt((100 * lower) / deltas.length, 0)}%)`
        );
    }
    console.log('\n  Reminder: the sign is pool-dependent and the absolute level is model-shaped');
    console.log('  (realized-equity DD, bags excluded) — compare within a pool, not across.');

    const base = path.basename(path.resolve(cfg.dataPath)).replace(/\.json$/i, '');
    const outPath = cfg.outPath ?? path.join(PATHS.ANALYSIS.RESULTS_DIR, `lookback_drawdown_${base}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    writeJSON(outPath, {
        meta: {
            generatedAt: new Date().toISOString(),
            dataPath: path.relative(process.cwd(), path.resolve(cfg.dataPath)),
            files,
            candles: candles.length,
            ama: amaDef,
            warmupBars,
            lookbacks: cfg.lookbacks,
            referenceLookback: REFERENCE_LOOKBACK,
            geometries: combos.length,
            asymmetricBounds: cfg.asymmetricBounds,
            feeRoundtripPct: cfg.feeRoundtripPct,
            capital: cfg.capital,
            repositionPct: cfg.repositionPct,
            note: 'Paired persistent-grid comparison: each geometry is simulated once per lookback so the delta isolates the window. Drawdown is realized-equity peak-to-trough (carried bags excluded); the sign of the lookback delta is pool-dependent.',
        },
        results: byLookback,
    });
    console.log(`\nSaved: ${path.relative(process.cwd(), outPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { run(); } catch (err) { console.error(err); process.exit(1); }
}

export { run, parseArgs };
