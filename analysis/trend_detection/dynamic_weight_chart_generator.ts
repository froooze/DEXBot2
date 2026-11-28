'use strict';

import { DEFAULT_CONFIG, MARKET_ADAPTER } from '../../modules/constants.js';
import { getAmaWarmupBars } from '../../market_adapter/core/strategies/ama.js';
import { bilinearInterpolate } from '../../market_adapter/core/strategies/regime_interp.js';
import { computeDynamicWeightSeries, computeHuberWindowSlopePct, computeAmaSlopeEmaSeries, computeAmaSlopeClipThreshold, echoLatchSeries, roundToN } from '../../market_adapter/core/strategies/dynamic_weight_series.js';
import {
    buildKalmanVelocitySeries,
    computeAbsolutePercentileThreshold,
    resolveKalmanVelocitySmoothingConfig,
    smoothKalmanVelocityPoint,
} from '../../market_adapter/core/signals/kalman_velocity_smoothing.js';
import { embedFunctionSources, escapeHtml, serializeJsonForScript, toEpochSeconds, UPLOT_SHARED_SCRIPT, VIEWPORT_CLIP_SCRIPT, uplotInlineTags } from '../chart_utils.js';
import { sharedChartCSS } from '../chart_css.js';
import { Y_AXIS_SIZE, makeCursorConfig, bindHoverStateFn, wireChartEvents, zoomResetScript, sizeChartsFn, formatTimeLabelFn, refreshChartsPreservingZoomFn } from '../chart_ui.js';

// Lookback slider bounds, shared with the research runner so its precomputed
// slope/percentile arrays are built with the same window the chart displays.
// Same bounds the bot editor uses (single source of truth in constants).
const CHART_LOOKBACK_BARS_BOUNDS = {
    MIN: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS_MIN,
    MAX: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS_MAX,
};

// Browser-embedded shared functions — the interactive chart runs the exact same
// pure logic as the live market adapter service instead of a hand-copied copy.
const EMBEDDED_SHARED_FUNCS = embedFunctionSources([
    computeHuberWindowSlopePct,
    computeAmaSlopeEmaSeries,
    computeAmaSlopeClipThreshold,
    bilinearInterpolate,
    echoLatchSeries,
    buildKalmanVelocitySeries,
    resolveKalmanVelocitySmoothingConfig,
    smoothKalmanVelocityPoint,
    computeAbsolutePercentileThreshold,
    computeDynamicWeightSeries,
    roundToN,
]);

interface DynamicWeightRow {
    timestamp: string | number;
    price: number;
    hurst?: number | null;
    pe?: number | null;
    hurstSegment?: number | null;
    peSegment?: number | null;
    amaSlopePct?: number | null;
    velocityRawPct?: number | null;
    velocityPct?: number | null;
    displacementRawPct?: number | null;
    displacementPct?: number | null;
    isReady?: boolean;
    signal?: string | null;
    ama3Price?: number | null;
}

interface DynWeightCfg {
    alpha?: number;
    gain?: number;
    dispWeight?: number;
    neutralZonePct?: number;
    amaNeutralZonePct?: number;
    lookbackBars?: number;
    amaLookbackBars?: number;
    amaMaxSlopePct?: number;
    kalmanMaxSlopePct?: number;
    clipPercentile?: number;
    minOutputThreshold?: number;
    outputClamp?: number;
    dispScaleMinPct?: number;
    regimeSensitivity?: number;
    absoluteThreshold?: number;
    amaSlopeEmaAlpha?: number;
}

interface DynamicWeightChartInput {
    allResults?: DynamicWeightRow[];
    marketAdapter?: DynWeightCfg;
    amaWeightConfig?: DynWeightCfg;
    amaConfig?: { erPeriod?: number; fastPeriod?: number; slowPeriod?: number };
    alpha?: number;
    gain?: number;
    dispWeight?: number;
    clipPct?: number;
    minOutputThreshold?: number;
    outputClamp?: number;
    absoluteThreshold?: number;
    lookbackBars?: number;
    neutralZonePct?: number;
    amaMaxSlopePct?: number;
    kalmanMaxSlopePct?: number;
    dispScaleMinPct?: number;
    regimeSensitivity?: number;
    signalConfirmBars?: number;
    kalmanSmoothPct?: number;
    kalmanDispScaleMult?: number;
    kalmanDispThresholdMult?: number;
    kalmanSmoothSpanPct?: number;
    amaSlopeEmaAlpha?: number;
    [key: string]: unknown;
}

function generateHTML(data: DynamicWeightChartInput, title = 'Dynamic Weight Research') {
    const results = data.allResults || [];
    if (results.length === 0) throw new Error('No analysis results in input');

    // Slider ranges — single source of truth for HTML attrs, tooltips,
    // payload transport, and client paste-clamp bounds.
    const LB_MIN = CHART_LOOKBACK_BARS_BOUNDS.MIN;
    const LB_MAX = CHART_LOOKBACK_BARS_BOUNDS.MAX;
    const GAIN_MIN = 0.5,     GAIN_MAX = 2.0;
    const AMA_MS_MIN = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT_MIN, AMA_MS_MAX = 0.12;
    const KAL_MS_MIN = 0.75,  KAL_MS_MAX = 1.5;
    const CLIP_PCT_MAX = 20;
    const TH_MIN = 0,         TH_MAX = 0.5;
    const KF_MIN = 0,         KF_MAX = 200;
    const KFD_MIN = 1.0,      KFD_MAX = 3.0;
    const DSP_MIN = 0.25,     DSP_MAX = 4.0;
    const KDT_MIN = 0.25,     KDT_MAX = 3.0;
    const KFS_MIN = 20,       KFS_MAX = 200;
    const CF_MIN = 0,         CF_MAX = 5;
    const REGI_MIN = 0,       REGI_MAX = 2;
    // AMA slope EMA: range and default come from MARKET_ADAPTER so the chart
    // and the live adapter always start from the same value. Left = off (1),
    // right = the 100-bar variance-equivalent alpha 2/(100+1).
    const EMA_MIN = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA_MIN;
    const EMA_MAX = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA_MAX;
    const SLIDER_RANGES = {
        alpha:                  [0, 1],
        dispWeight:             [0, 1],
        neutralZonePct:         [0, 1],
        lookbackBars:           [LB_MIN, LB_MAX],
        amaMaxSlopePct:         [AMA_MS_MIN, AMA_MS_MAX],
        kalmanMaxSlopePct:      [KAL_MS_MIN, KAL_MS_MAX],
        clipPct:                [0, CLIP_PCT_MAX],
        minOutputThreshold:     [TH_MIN, TH_MAX],
        kalmanSmoothPct:        [KF_MIN, KF_MAX],
        kalmanDispScaleMult:    [KFD_MIN, KFD_MAX],
        dispScaleMinPct:        [DSP_MIN, DSP_MAX],
        kalmanDispThresholdMult: [KDT_MIN, KDT_MAX],
        kalmanSmoothSpanPct:    [KFS_MIN, KFS_MAX],
        signalConfirmBars:      [CF_MIN, CF_MAX],
        gain:                   [GAIN_MIN, GAIN_MAX],
        regimeSensitivity:      [REGI_MIN, REGI_MAX],
        amaSlopeEmaAlpha:       [EMA_MIN, EMA_MAX],
    };

    const ma = data.marketAdapter || {};
    const amaWeightConfig = data.amaWeightConfig || {};
    const defaultAlpha        = data.alpha            ?? ma.alpha ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ALPHA;
    const defaultGain         = data.gain             ?? ma.gain ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_GAIN;
    const defaultNeutralZone  = amaWeightConfig.neutralZonePct ?? ma.amaNeutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
    const defaultDispWeight   = data.dispWeight       ?? ma.dispWeight ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DW;
    const defaultAmaMaxSlopePct = amaWeightConfig.amaMaxSlopePct
        ?? ma.amaMaxSlopePct
        ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
    const defaultKalmanMaxSlopePct = amaWeightConfig.kalmanMaxSlopePct
        ?? ma.kalmanMaxSlopePct
        ?? defaultAmaMaxSlopePct
        ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT;
    const defaultClipPct      = data.clipPct          ?? ma.clipPercentile ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;
    const defaultMinOutputThresholdRaw = data.minOutputThreshold ?? ma.minOutputThreshold ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD;
    const defaultMinOutputThreshold = Math.min(Math.max(defaultMinOutputThresholdRaw, TH_MIN), TH_MAX);
    const defaultOutputClamp = data.outputClamp ?? ma.outputClamp ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
    const lookbackBarsRaw     = amaWeightConfig.lookbackBars  ?? ma.amaLookbackBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
    const lookbackBars        = Math.ceil(Math.max(LB_MIN, Math.min(LB_MAX, Number.isFinite(lookbackBarsRaw) ? lookbackBarsRaw : LB_MIN)));

    // Log mapping for lookback slider
    const LB_LOG_MIN_N = Math.log(LB_MIN);
    const LB_LOG_MAX_N = Math.log(LB_MAX);
    const clampedLb = Math.min(Math.max(lookbackBars, LB_MIN), LB_MAX);
    const lbInitSlider = Math.round((Math.log(clampedLb) - LB_LOG_MIN_N) / (LB_LOG_MAX_N - LB_LOG_MIN_N) * 1000);

    // Log mapping for gain slider
    const GAIN_LOG_MIN_N = Math.log(GAIN_MIN);
    const GAIN_LOG_MAX_N = Math.log(GAIN_MAX);
    const clampedGain = Math.min(Math.max(defaultGain, GAIN_MIN), GAIN_MAX);
    const gainInitSlider = Math.round((Math.log(clampedGain) - GAIN_LOG_MIN_N) / (GAIN_LOG_MAX_N - GAIN_LOG_MIN_N) * 1000);

    // Log mapping for slope saturation sliders
    const AMA_MS_LOG_MIN_N = Math.log(AMA_MS_MIN);
    const AMA_MS_LOG_MAX_N = Math.log(AMA_MS_MAX);
    const KAL_MS_LOG_MIN_N = Math.log(KAL_MS_MIN);
    const KAL_MS_LOG_MAX_N = Math.log(KAL_MS_MAX);
    const clampedAmaMs = Math.min(Math.max(defaultAmaMaxSlopePct, AMA_MS_MIN), AMA_MS_MAX);
    const clampedKalMs = Math.min(Math.max(defaultKalmanMaxSlopePct, KAL_MS_MIN), KAL_MS_MAX);
    const amaMsInitSlider = Math.round((Math.log(clampedAmaMs) - AMA_MS_LOG_MIN_N) / (AMA_MS_LOG_MAX_N - AMA_MS_LOG_MIN_N) * 1000);
    const kalMsInitSlider = Math.round((Math.log(clampedKalMs) - KAL_MS_LOG_MIN_N) / (KAL_MS_LOG_MAX_N - KAL_MS_LOG_MIN_N) * 1000);

    const defaultRegimeSensitivity  = data.regimeSensitivity ?? ma.regimeSensitivity ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_REGIME_SENSITIVITY;
    const defaultAbsoluteThreshold  = ma.absoluteThreshold ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ABSOLUTE_THRESHOLD_DEFAULT;
    const defaultDispScaleMinPct     = data.dispScaleMinPct  ?? ma.dispScaleMinPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT;
    const defaultKalmanSmoothPct = data.kalmanSmoothPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_PCT_DEFAULT;
    const defaultKalmanDispScaleMult = data.kalmanDispScaleMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_SCALE_MULT_DEFAULT;
    const defaultKalmanDispThresholdMult = data.kalmanDispThresholdMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_THRESHOLD_MULT_DEFAULT;
    const defaultKalmanSmoothSpanPct = data.kalmanSmoothSpanPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_SPAN_PCT_DEFAULT;
    const defaultSignalConfirmBars = data.signalConfirmBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SIGNAL_CONFIRM_BARS_DEFAULT;
    const regimeInitSlider = Math.round(defaultRegimeSensitivity * 100);

    // Log mapping for the EMA alpha slider; low values (heavy smoothing) get
    // more resolution. Left = 1.00 (off), right = 100-bar equivalent alpha.
    const EMA_LOG_MIN_N = Math.log(EMA_MIN);
    const EMA_LOG_MAX_N = Math.log(EMA_MAX);
    const clampedEma = Math.min(Math.max(
        data.amaSlopeEmaAlpha ?? ma.amaSlopeEmaAlpha ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA,
        EMA_MIN
    ), EMA_MAX);
    const emaInitSlider = Math.round((Math.log(clampedEma) - EMA_LOG_MAX_N) / (EMA_LOG_MIN_N - EMA_LOG_MAX_N) * 1000);

    const interval = results.length > 1 ?
        (new Date(results[1].timestamp).getTime() - new Date(results[0].timestamp).getTime()) / 1000 : 3600;

    const dates              = results.map((r: DynamicWeightRow, idx: number) => toEpochSeconds(r.timestamp || Date.now(), idx));
    const prices: (number | null)[] = results.map((r: DynamicWeightRow) => r.price);
    const hurstArr           = results.map((r: DynamicWeightRow) => r.hurst ?? null);
    const peArr             = results.map((r: DynamicWeightRow) => r.pe ?? null);
    const hurstSegments     = results.map((r: DynamicWeightRow) => r.hurstSegment ?? null);
    const peSegments        = results.map((r: DynamicWeightRow) => r.peSegment ?? null);
    const amaSlopePct       = results.map((r: DynamicWeightRow) => r.amaSlopePct ?? null);
    const kalmanVelocityPctRaw = results.map((r: DynamicWeightRow) => r.velocityRawPct ?? r.velocityPct ?? null);
    const kalmanDisplacementPct = results.map((r: DynamicWeightRow) => r.displacementRawPct ?? r.displacementPct ?? null);
    const kalmanVelocityPct = buildKalmanVelocitySeries(
        results.map((r: DynamicWeightRow) => ({ velocityPct: r.velocityRawPct ?? r.velocityPct ?? null, displacementPct: r.displacementRawPct ?? r.displacementPct ?? null })),
        {
            kalmanSmoothPct: defaultKalmanSmoothPct,
            kalmanDispScaleMult: defaultKalmanDispScaleMult,
            kalmanDispThresholdMult: defaultKalmanDispThresholdMult,
            kalmanSmoothSpanPct: defaultKalmanSmoothSpanPct,
        }
    );
    const kalmanIsReady: (boolean | null)[] = results.map((r: DynamicWeightRow) => r.isReady ?? false);
    const signals            = results.map((r: DynamicWeightRow) => r.signal);
    const amaLabel           = data.amaKey || 'AMA3';
    const ama3Prices         = results.map((r: DynamicWeightRow) => r.ama3Price ?? null);
    const defaultAmaKey = MARKET_ADAPTER.DEFAULT_AMA_KEY as keyof typeof MARKET_ADAPTER.AMAS;
    const amaErPeriod        = data.amaConfig?.erPeriod ?? MARKET_ADAPTER.AMAS[defaultAmaKey].erPeriod;
    const amaSlowPeriod      = data.amaConfig?.slowPeriod ?? MARKET_ADAPTER.AMAS[defaultAmaKey].slowPeriod;
    const amaFastPeriod      = data.amaConfig?.fastPeriod ?? MARKET_ADAPTER.AMAS[defaultAmaKey].fastPeriod;
    const amaWarmupBars      = getAmaWarmupBars(amaErPeriod, amaSlowPeriod, lookbackBars, amaFastPeriod);
    const amaSlopeReadyBars  = Math.ceil(amaErPeriod) + lookbackBars;
    const amaSeedSmaLine     = new Array(results.length).fill(null);
    const amaSeedWindowEnd   = Math.min(results.length - 1, Math.ceil(amaErPeriod));
    if (amaSeedWindowEnd >= 0) {
        let seedSum = 0;
        let seedCount = 0;
        for (let i = 0; i <= amaSeedWindowEnd; i++) {
            if (Number.isFinite(prices[i])) {
                seedSum += prices[i] as number;
                seedCount++;
            }
        }
        if (seedCount > 0) {
            const seedSma = seedSum / seedCount;
            for (let i = 0; i <= amaSeedWindowEnd; i++) {
                amaSeedSmaLine[i] = seedSma;
            }
        }
    }

    const lastDate = dates[dates.length - 1];
    for (let i = 1; i <= 150; i++) {
        dates.push(lastDate + (i * interval));
        prices.push(null);
        hurstArr.push(null);
        peArr.push(null);
        hurstSegments.push(null);
        peSegments.push(null);
        amaSlopePct.push(null);
        kalmanVelocityPctRaw.push(null);
        kalmanVelocityPct.push(null);
        kalmanDisplacementPct.push(null);
        kalmanIsReady.push(null);
        signals.push(null);
        ama3Prices.push(null);
        amaSeedSmaLine.push(null);
    }

    const realBarCount = results.length;

    function buildPercentiles(arr: Array<number | null>, startIndex = 0) {
        const safeStartIndex = Math.max(0, Math.min(realBarCount, Math.ceil(startIndex)));
        const sorted: number[] = [];
        for (let i = safeStartIndex; i < realBarCount; i++) { const v = arr[i]; if (v != null) sorted.push(Math.abs(v)); }
        sorted.sort((a, b) => a - b);
        // Empty pool → Infinity: the live percentile lookup treats an empty
        // history as "no clipping" (percentileFromSorted returns Infinity);
        // collapsing to 0 here would clip every slope to ±0 instead.
        if (sorted.length === 0) return new Array(101).fill(Infinity);
        const pcts: number[] = [];
        for (let p = 0; p <= 100; p++) {
            const idx = Math.min(Math.floor(sorted.length * p / 100), sorted.length - 1);
            pcts.push(sorted[idx]);
        }
        return pcts;
    }
    const amaPercentiles = buildPercentiles(amaSlopePct, amaSlopeReadyBars);
    const kalPercentiles = buildPercentiles(kalmanVelocityPct);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)}</title>
    ${uplotInlineTags()}
    <style>
        ${sharedChartCSS()}
        /* Panel titles sit at the top-right; make them clearly readable
           (shared CSS uses a very dark #30363d that vanishes on the dark bg). */
        .section-label { color: #c9d1d9; font-size: 10px; }
        #price-panel  { flex: 0 0 34%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #ama-panel    { flex: 0 0 14%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #kalman-panel { flex: 0 0 21%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #output-panel { flex: 1 1 0;   min-height: 0; position: relative; }
        .legend { left: 70px; flex-wrap: wrap; gap: 4px 8px; color: #8b949e; max-width: calc(100% - 86px); }
        .legend-item { gap: 3px; }
        .legend-val { font-family: monospace; display: inline-block; text-align: right; min-width: 45px; }
        #l-price, #l-ama3 { min-width: 62px; }
        #l-ama-slope, #l-kal-vel, #l-kal-disp { min-width: 54px; }
        #l-signal, #l-signal-latched { min-width: 70px; text-align: left; }
        #l-combined-raw, #l-combined-echo { min-width: 42px; }
        #l-mult { min-width: 38px; }
        #l-sell, #l-buy { min-width: 30px; }
        .ctrl { pointer-events: auto; display: inline-flex; align-items: center; gap: 2px; margin-left: 4px; }
        .ctrl label { color: #8b949e; font-size: 10px; min-width: 24px; text-align: right; margin-right: 2px; }
        .ctrl.alpha label { min-width: 8px; }
        .ctrl.ms label { min-width: 32px; }
        .ctrl.clip label { min-width: 30px; }
        .ctrl.off label { min-width: 24px; }
        .ctrl.regime label { min-width: 24px; }
        .ctrl input[type="range"] { width: 80px; height: 3px; }
        .ctrl .val { font-weight: bold; font-size: 10px; min-width: 30px; display: inline-block; text-align: right; }
        .group-sep { border-left: 1px solid #30363d; margin-left: 6px; padding-left: 4px; display: inline-flex; align-items: center; height: 16px; }
        .group-label { font-size: 9px; color: #484f58; text-transform: uppercase; letter-spacing: 0.5px; margin-left: 8px; font-weight: bold; }
        .ctrl.alpha input[type="range"] { accent-color: #58a6ff; width: 80px; }
        .ctrl.alpha .val { color: #58a6ff; }
        .ctrl.dw label { min-width: 20px; }
        .ctrl.dw input[type="range"] { accent-color: #a371f7; width: 80px; }
        .ctrl.dw .val { color: #a371f7; }
        .ctrl.kf label { min-width: 20px; }
        .ctrl.kf input[type="range"] { accent-color: #79c0ff; width: 80px; }
        .ctrl.kf .val { color: #79c0ff; }
        .ctrl.kfd label { min-width: 20px; }
        .ctrl.kfd input[type="range"] { accent-color: #58a6ff; width: 80px; }
        .ctrl.kfd .val { color: #58a6ff; }
        .ctrl.kdt label { min-width: 20px; }
        .ctrl.kdt input[type="range"] { accent-color: #f78166; width: 80px; }
        .ctrl.kdt .val { color: #f78166; }
        .ctrl.kfs label { min-width: 20px; }
        .ctrl.kfs input[type="range"] { accent-color: #ffab70; width: 80px; }
        .ctrl.kfs .val { color: #ffab70; }
        .ctrl.ms-ama label { min-width: 32px; }
        .ctrl.ms-ama input[type="range"] { accent-color: #e3b341; width: 80px; }
        .ctrl.ms-ama .val { color: #e3b341; }
        .ctrl.ms-kal label { min-width: 32px; }
        .ctrl.ms-kal input[type="range"] { accent-color: #f0883e; width: 80px; }
        .ctrl.ms-kal .val { color: #f0883e; }
        .ctrl.cf label { min-width: 20px; }
        .ctrl.cf input[type="range"] { accent-color: #d2a8ff; width: 80px; }
        .ctrl.cf .val { color: #d2a8ff; }
        .ctrl.lb label { min-width: 20px; }
        .ctrl.lb input[type="range"] { accent-color: #39d0d8; width: 80px; }
        .ctrl.lb .val { color: #39d0d8; }
        .ctrl.sema label { min-width: 26px; }
        .ctrl.sema input[type="range"] { accent-color: #f0a000; width: 80px; }
        .ctrl.sema .val { color: #f0a000; }
        .ctrl.off input[type="range"] { accent-color: #3fb950; }
        .ctrl.off .val { color: #3fb950; }
        .ctrl.nz input[type="range"] { accent-color: #8b949e; }
        .ctrl.nz .val { color: #8b949e; }
        .copy-btn, .paste-btn, .reset-btn { pointer-events: auto; margin-left: 6px; padding: 2px 10px; font-size: 10px; background: #21262d; color: #8b949e; border: 1px solid #30363d; border-radius: 4px; cursor: pointer; }
        .copy-btn:hover, .paste-btn:hover, .reset-btn:hover { background: #30363d; color: #e6edf3; }
        .copy-btn.copied { color: #3fb950; border-color: #3fb950; }
        .paste-btn.pasted { color: #58a6ff; border-color: #58a6ff; }
        .paste-btn.error  { color: #f85149; border-color: #f85149; }
        .reset-btn.reset  { color: #d29922; border-color: #d29922; }
        #paste-confirm { display: none; position: fixed; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 14px 16px; z-index: 1000; box-shadow: 0 4px 24px rgba(0,0,0,0.7); min-width: 200px; }
        #paste-confirm-title { font-size: 10px; color: #8b949e; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
        #paste-confirm-vals { font-size: 11px; font-family: monospace; color: #e6edf3; line-height: 1.7; margin-bottom: 12px; }
        #paste-confirm-vals span { color: #58a6ff; }
        #paste-confirm-btns { display: flex; gap: 6px; justify-content: flex-end; }
        #paste-confirm-btns button { padding: 3px 12px; font-size: 10px; border-radius: 4px; cursor: pointer; border: 1px solid #30363d; background: #21262d; color: #8b949e; }
        #paste-confirm-apply { background: #1f4e23 !important; color: #3fb950 !important; border-color: #3fb950 !important; }
        #paste-confirm-apply:hover { background: #2ea043 !important; color: #fff !important; }

        .ctrl.clip input[type="range"] { accent-color: #da3633; }
        .ctrl.clip .val { color: #da3633; }
        .ctrl.regime input[type="range"] { accent-color: #d2a8ff; }
        .ctrl.regime .val { color: #d2a8ff; }
        .row-break { flex-basis: 100%; height: 0; }
    </style>
</head>
<body>
    <div id="header">
        <div style="font-weight:bold;color:#fff;">${escapeHtml(title)}</div>
        <div style="font-size:11px;color:#8b949e;text-transform:uppercase;">Log Price &nbsp;\u2192&nbsp; AMA Slope &nbsp;\u2192&nbsp; Kalman Composite &nbsp;\u2192&nbsp; Dynamic Weight &nbsp;&nbsp;|&nbsp;&nbsp; Scroll \u00b7 Drag \u00b7 Ctrl+0</div>
    </div>

    <div id="panels">
        <div id="price-panel">
            <div class="section-label">PRICE (LOG)</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#58a6ff;"></div>Price: <span id="l-price" class="legend-val" style="font-weight:bold;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#e3b341;"></div>${amaLabel}: <span id="l-ama3" class="legend-val" style="font-weight:bold;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#8b949e;"></div>Seed SMA: <span id="l-seed-sma" class="legend-val">-</span></div>
            </div>
            <div id="price-chart"></div>
        </div>
        <div id="ama-panel">
            <div class="section-label">AMA SLOPE INPUT</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#f0a000;"></div>Slope‰: <span id="l-ama-slope" class="legend-val" style="font-weight:bold;">-</span></div>
            </div>
            <div id="ama-chart"></div>
        </div>
        <div id="kalman-panel">
            <div class="section-label">KALMAN COMPOSITE INPUT</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#d2a8ff;"></div>Vel%: <span id="l-kal-vel" class="legend-val" style="font-weight:bold;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#79c0ff;"></div>Disp%: <span id="l-kal-disp" class="legend-val">-</span></div>
                <div class="legend-item">Raw: <span id="l-signal" class="legend-val" style="font-weight:bold;">-</span></div>
                <div class="legend-item">Echo: <span id="l-signal-echo" class="legend-val" style="font-weight:bold;">-</span></div>
                <div class="legend-item">Latched: <span id="l-signal-latched" class="legend-val" style="font-weight:bold;">-</span></div>
            </div>
            <div id="kalman-chart"></div>
        </div>
        <div id="output-panel">
            <div class="section-label">COMBINED WEIGHT OUTPUT</div>
            <div class="legend" style="gap: 4px;">
                <div class="legend-item"><div class="dot" style="background:linear-gradient(to bottom,#8b949e,#8b949e);"></div>Raw: <span id="l-combined-raw" class="legend-val" style="font-weight:bold;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:linear-gradient(to bottom,#2ea043,#f85149);"></div>Echo: <span id="l-combined-echo" class="legend-val" style="font-weight:bold;">-</span></div>
                <div class="legend-item">xMult: <span id="l-mult" class="legend-val" style="font-weight:bold;color:#d2a8ff;">-</span></div>
                <div class="legend-item">S: <span id="l-sell" class="legend-val" style="color:#ff7b72;">-</span></div>
                <div class="legend-item">B: <span id="l-buy" class="legend-val" style="color:#58a6ff;">-</span></div>

                <div class="group-sep"></div>
                <div class="ctrl alpha"><label for="alpha-slider">α</label><input type="range" id="alpha-slider" min="0" max="100" value="${Math.round(defaultAlpha * 100)}" title="Alpha Mix (AMA vs Kalman)"><span class="val" id="alpha-value">${defaultAlpha.toFixed(2)}</span></div>
                <div class="ctrl dw"><label for="dw-slider">dw</label><input type="range" id="dw-slider" min="0" max="100" value="${Math.round(defaultDispWeight * 100)}" title="Displacement Weight"><span class="val" id="dw-value">${defaultDispWeight.toFixed(2)}</span></div>

                <div class="group-sep"></div>
                <div class="ctrl nz"><label for="nz-slider">nz%</label><input type="range" id="nz-slider" min="0" max="100" value="${Math.round(defaultNeutralZone * 100)}" title="Neutral Zone %"><span class="val" id="nz-value">${defaultNeutralZone.toFixed(2)}</span></div>
                <div class="ctrl lb"><label for="lb-slider">lb</label><input type="range" id="lb-slider" min="0" max="1000" value="${lbInitSlider}" title="Lookback Bars (${LB_MIN}-${LB_MAX})"><span class="val" id="lb-value">${lookbackBars}</span></div>
                <div class="ctrl sema"><label for="ema-slider">ema</label><input type="range" id="ema-slider" min="0" max="1000" value="${emaInitSlider}" title="Stateful AMA slope EMA alpha (log scale): left = 1.00 off, right = ${EMA_MIN.toFixed(3)} = 100-bar equivalent (alpha = 2/(N+1)). Applied to both the plotted slope and the AMA offset channel."><span class="val" id="ema-value">${clampedEma >= EMA_MAX - 1e-9 ? 'off' : clampedEma.toFixed(3)}</span></div>
                <div class="ctrl ms-ama"><label for="ama-ms-slider">amaS%</label><input type="range" id="ama-ms-slider" min="0" max="1000" value="${amaMsInitSlider}" title="AMA Max Slope % per bar (${AMA_MS_MIN}-${AMA_MS_MAX})"><span class="val" id="ama-ms-value">${defaultAmaMaxSlopePct.toFixed(4)}</span></div>
                <div class="ctrl clip"><label for="clip-slider">clip%</label><input type="range" id="clip-slider" min="0" max="${CLIP_PCT_MAX}" value="${Math.min(defaultClipPct, CLIP_PCT_MAX)}" title="Outlier Clip %"><span class="val" id="clip-value">${Math.min(defaultClipPct, CLIP_PCT_MAX)}%</span></div>

                <div class="group-sep"></div>
                <div class="ctrl th"><label for="th-slider">th%</label><input type="range" id="th-slider" min="0" max="${TH_MAX * 100}" value="${Math.round(defaultMinOutputThreshold * 100)}" title="Minimum pre-gain blended output required before the signal is allowed through (${TH_MIN.toFixed(2)}-${TH_MAX.toFixed(2)})"><span class="val" id="th-value">${defaultMinOutputThreshold.toFixed(2)}</span></div>

                <div class="group-sep"></div>
                <div class="row-break"></div>
        <div class="ctrl ms-kal"><label for="kal-ms-slider">kalS%</label><input type="range" id="kal-ms-slider" min="0" max="1000" value="${kalMsInitSlider}" title="Kalman Max Slope % (${KAL_MS_MIN}-${KAL_MS_MAX})"><span class="val" id="kal-ms-value">${clampedKalMs.toFixed(2)}</span></div>
        <div class="ctrl kf"><label for="kf-slider">kf</label><input type="range" id="kf-slider" min="${KF_MIN}" max="${KF_MAX}" value="${defaultKalmanSmoothPct}" title="Kalman smoothing blend (${KF_MIN} = raw, 100 = current adaptive smoothing, ${KF_MAX} = stronger smoothing)"><span class="val" id="kf-value">${defaultKalmanSmoothPct}%</span></div>
                <div class="ctrl kfd"><label for="kfd-slider">kfd</label><input type="range" id="kfd-slider" min="${KFD_MIN * 100}" max="${KFD_MAX * 100}" value="${Math.round(defaultKalmanDispScaleMult * 100)}" title="Kalman displacement scale multiplier (${KFD_MIN}x to ${KFD_MAX}x)"><span class="val" id="kfd-value">${defaultKalmanDispScaleMult.toFixed(2)}x</span></div>
                <div class="ctrl dsp"><label for="dsp-slider">dsp</label><input type="range" id="dsp-slider" min="${DSP_MIN * 100}" max="${DSP_MAX * 100}" value="${Math.round(defaultDispScaleMinPct * 100)}" title="Minimum displacement scale floor (${DSP_MIN}x to ${DSP_MAX.toFixed(1)}x)"><span class="val" id="dsp-value">${defaultDispScaleMinPct.toFixed(2)}x</span></div>
                <div class="ctrl kdt"><label for="kdt-slider">kdt</label><input type="range" id="kdt-slider" min="${KDT_MIN * 100}" max="${KDT_MAX * 100}" value="${Math.round(defaultKalmanDispThresholdMult * 100)}" title="Kalman displacement threshold multiplier (${KDT_MIN}x to ${KDT_MAX}x)"><span class="val" id="kdt-value">${defaultKalmanDispThresholdMult.toFixed(2)}x</span></div>
                <div class="ctrl kfs"><label for="kfs-slider">kfs</label><input type="range" id="kfs-slider" min="${KFS_MIN}" max="${KFS_MAX}" value="${defaultKalmanSmoothSpanPct}" title="Adaptive EMA span ratio (${KFS_MIN}% span / ${KFS_MAX}% span; floor fixed at 0)"><span class="val" id="kfs-value">${defaultKalmanSmoothSpanPct}%</span></div>
                <div class="ctrl cf"><label for="cf-slider">cf</label><input type="range" id="cf-slider" min="${CF_MIN}" max="${CF_MAX}" value="${defaultSignalConfirmBars}" title="Signal confirmation bars (0 disables latching; otherwise flips after N opposite echo bars)"><span class="val" id="cf-value">${defaultSignalConfirmBars}</span></div>
                <div class="ctrl off"><label for="gain-slider">gain</label><input type="range" id="gain-slider" min="0" max="1000" value="${gainInitSlider}" title="Output Gain (${GAIN_MIN.toFixed(1)}-${GAIN_MAX.toFixed(1)})"><span class="val" id="gain-value">${clampedGain.toFixed(3)}</span></div>
                <div class="ctrl regime"><label for="regime-slider">regi</label><input type="range" id="regime-slider" min="0" max="${REGI_MAX * 100}" value="${regimeInitSlider}" title="Regime Sensitivity"><span class="val" id="regime-value">${defaultRegimeSensitivity.toFixed(2)}</span></div>
                <button class="copy-btn" id="copy-params-btn">copy</button>
                <button class="paste-btn" id="paste-params-btn">paste</button>
                <button class="reset-btn" id="reset-params-btn">reset</button>
            </div>
            <div id="output-chart"></div>
        </div>
    </div>

    <div id="paste-confirm">
        <div id="paste-confirm-title">Confirm paste parameters</div>
        <div id="paste-confirm-vals"></div>
        <div id="paste-confirm-btns">
            <button id="paste-confirm-cancel">Cancel</button>
            <button id="paste-confirm-apply">Apply</button>
        </div>
    </div>

    <script id="payload" type="application/json">${serializeJsonForScript({ dates, prices, hurstArr, peArr, hurstSegments, peSegments, ama3Prices, amaSeedSmaLine, kalmanVelocityPctRaw, kalmanVelocityPct, kalmanDisplacementPct, kalmanIsReady, signals, alpha: defaultAlpha, gain: defaultGain, kalmanSmoothPct: defaultKalmanSmoothPct, kalmanDispScaleMult: defaultKalmanDispScaleMult, kalmanDispThresholdMult: defaultKalmanDispThresholdMult, kalmanSmoothSpanPct: defaultKalmanSmoothSpanPct, signalConfirmBars: defaultSignalConfirmBars, neutralZonePct: defaultNeutralZone, dispWeight: defaultDispWeight, amaMaxSlopePct: defaultAmaMaxSlopePct, kalmanMaxSlopePct: defaultKalmanMaxSlopePct, clipPct: defaultClipPct, minOutputThreshold: defaultMinOutputThreshold, outputClamp: defaultOutputClamp, regimeSensitivity: defaultRegimeSensitivity, absoluteThreshold: defaultAbsoluteThreshold, lookbackBars, amaErPeriod, amaSlowPeriod, amaWarmupBars, amaSlopeReadyBars, realBarCount, amaPercentiles, kalPercentiles, amaSlopeLogMin: AMA_MS_LOG_MIN_N, amaSlopeLogMax: AMA_MS_LOG_MAX_N, kalSlopeLogMin: KAL_MS_LOG_MIN_N, kalSlopeLogMax: KAL_MS_LOG_MAX_N, lbLogMin: LB_LOG_MIN_N, lbLogMax: LB_LOG_MAX_N, gainLogMin: GAIN_LOG_MIN_N, gainLogMax: GAIN_LOG_MAX_N, sliderRanges: SLIDER_RANGES, amaSlopeEmaAlpha: clampedEma, dispScaleMinPct: defaultDispScaleMinPct, weightMin: MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT, weightMax: MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT, marketAdapter: ma, amaWeightConfig, hNodes: [0.5 + MARKET_ADAPTER.HURST_ZONE_BAND, 0.5, 0.5 - MARKET_ADAPTER.HURST_ZONE_BAND], pNodes: MARKET_ADAPTER.PE_NODES, regimeTable: MARKET_ADAPTER.REGIME_TABLE })}</script>

    <script>
        const data = JSON.parse(document.getElementById('payload').textContent);

        // Canonical Huber-slope parameters, injected from MARKET_ADAPTER so the
        // embedded estimator runs the same values as the live adapter.
        const AMA_SLOPE_HUBER = ${serializeJsonForScript(MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER)};

        ${EMBEDDED_SHARED_FUNCS}

        const SYNC_KEY = "dyn-wt-res-v4";
        const Y_AXIS_SIZE = ${Y_AXIS_SIZE};
        const ma = data.marketAdapter || {};
        const amaWeightConfig = data.amaWeightConfig || {};
        const SR = data.sliderRanges ?? ${serializeJsonForScript(SLIDER_RANGES)};

        const ABSOLUTE_THRESHOLD = data.absoluteThreshold ?? ${JSON.stringify(defaultAbsoluteThreshold)};
        const WEIGHT_MIN = data.weightMin ?? ${JSON.stringify(MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT)};
        const WEIGHT_MAX = data.weightMax ?? ${JSON.stringify(MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT)};
        const OUTPUT_CLAMP = data.outputClamp ?? ${JSON.stringify(defaultOutputClamp)};
        const weightDistribution = ${serializeJsonForScript(DEFAULT_CONFIG.weightDistribution)};
        const STATIC_SELL = Number.isFinite(weightDistribution.sell) ? weightDistribution.sell : ${JSON.stringify(DEFAULT_CONFIG.weightDistribution.sell)};
        const STATIC_BUY = Number.isFinite(weightDistribution.buy) ? weightDistribution.buy : ${JSON.stringify(DEFAULT_CONFIG.weightDistribution.buy)};

        let currentAlpha   = data.alpha ?? ${JSON.stringify(defaultAlpha)};
        let currentGain  = data.gain ?? ${JSON.stringify(defaultGain)};
        let currentMinOutputThreshold = Math.min(Math.max(data.minOutputThreshold ?? ${JSON.stringify(defaultMinOutputThreshold)}, SR.minOutputThreshold[0]), SR.minOutputThreshold[1]);
        let currentKalmanSmoothPct = data.kalmanSmoothPct ?? ${JSON.stringify(defaultKalmanSmoothPct)};
        let currentKalmanDispScaleMult = data.kalmanDispScaleMult ?? ${JSON.stringify(defaultKalmanDispScaleMult)};
        let currentKalmanDispThresholdMult = data.kalmanDispThresholdMult ?? ${JSON.stringify(defaultKalmanDispThresholdMult)};
        let currentKalmanSmoothSpanPct = data.kalmanSmoothSpanPct ?? ${JSON.stringify(defaultKalmanSmoothSpanPct)};
        let currentDispScaleMinPct = data.dispScaleMinPct ?? ${JSON.stringify(defaultDispScaleMinPct)};
        let currentSignalConfirmBars = data.signalConfirmBars ?? ${JSON.stringify(defaultSignalConfirmBars)};
        let currentNz      = data.neutralZonePct ?? ${JSON.stringify(defaultNeutralZone)};
        let currentDw      = data.dispWeight ?? ${JSON.stringify(defaultDispWeight)};
        let currentAmaMaxSlopePct = data.amaMaxSlopePct ?? ${JSON.stringify(defaultAmaMaxSlopePct)};
        let currentKalmanMaxSlopePct = data.kalmanMaxSlopePct ?? ${JSON.stringify(defaultKalmanMaxSlopePct)};
        const AMA_MS_LOG_MIN = data.amaSlopeLogMin;
        const AMA_MS_LOG_MAX = data.amaSlopeLogMax;
        const KAL_MS_LOG_MIN = data.kalSlopeLogMin;
        const KAL_MS_LOG_MAX = data.kalSlopeLogMax;
        const amaMsSliderToVal = (pos) => Math.exp(AMA_MS_LOG_MIN + (pos / 1000) * (AMA_MS_LOG_MAX - AMA_MS_LOG_MIN));
        const kalMsSliderToVal = (pos) => Math.exp(KAL_MS_LOG_MIN + (pos / 1000) * (KAL_MS_LOG_MAX - KAL_MS_LOG_MIN));

        let currentLookbackBars = data.lookbackBars ?? ${JSON.stringify(lookbackBars)};
        const currentAmaSource = data.ama3Prices;
        const LB_LOG_MIN = data.lbLogMin;
        const LB_LOG_MAX = data.lbLogMax;
        const lbSliderToVal = (pos) => Math.round(Math.exp(LB_LOG_MIN + (pos / 1000) * (LB_LOG_MAX - LB_LOG_MIN)));
        const lbValToSlider = (val) => Math.round((Math.log(Math.max(SR.lookbackBars[0], val)) - LB_LOG_MIN) / (LB_LOG_MAX - LB_LOG_MIN) * 1000);

        const GAIN_LOG_MIN = data.gainLogMin;
        const GAIN_LOG_MAX = data.gainLogMax;
        const gainSliderToVal = (pos) => Math.exp(GAIN_LOG_MIN + (pos / 1000) * (GAIN_LOG_MAX - GAIN_LOG_MIN));
        const gainValToSlider = (val) => Math.round((Math.log(Math.max(Math.exp(GAIN_LOG_MIN), val)) - GAIN_LOG_MIN) / (GAIN_LOG_MAX - GAIN_LOG_MIN) * 1000);

        let currentClipPct = data.clipPct ?? ${JSON.stringify(defaultClipPct)};
        // The AMA clip threshold always comes from dynamicClipThreshold, which
        // recalcInputs() recomputes via the canonical
        // computeAmaSlopeClipThreshold (Infinity when clipping is disabled,
        // matching the live adapter). No separate clipPct==0 branch is needed.
        let currentKalClipThreshold = currentClipPct === 0 ? Infinity : data.kalPercentiles[100 - currentClipPct];

        // AMA slope EMA control. Default comes from MARKET_ADAPTER (0.2);
        // alpha 1 = raw Huber (off). Applied in recalcInputs() and fed to
        // computeDynamicWeightSeries via amaSlopePctSeries so the plotted
        // slope and the weight offsets agree.
        let currentAmaSlopeEmaAlpha = Math.max(SR.amaSlopeEmaAlpha[0], Math.min(SR.amaSlopeEmaAlpha[1], data.amaSlopeEmaAlpha ?? ${JSON.stringify(clampedEma)}));
        const EMA_LOG_MIN = ${JSON.stringify(EMA_LOG_MIN_N)};
        const EMA_LOG_MAX = ${JSON.stringify(EMA_LOG_MAX_N)};
        const emaSliderToVal = (pos) => Math.exp(EMA_LOG_MAX + (pos / 1000) * (EMA_LOG_MIN - EMA_LOG_MAX));
        const emaValToSlider = (val) => Math.round((Math.log(Math.max(SR.amaSlopeEmaAlpha[0], val)) - EMA_LOG_MAX) / (EMA_LOG_MIN - EMA_LOG_MAX) * 1000);
        const formatEmaLabel = (alpha) => alpha >= SR.amaSlopeEmaAlpha[1] - 1e-9 ? 'off' : alpha.toFixed(3);

        // Regime table and axis nodes from payload — sourced from MARKET_ADAPTER in constants.ts
        const REGIME_TABLE = data.regimeTable;
        const H_NODES = data.hNodes; // [0.5+band, 0.5, 0.5-band]
        const P_NODES = data.pNodes; // PE_NODES

        /**
         * Regime multiplier for smooth gating — canonical bilinear interpolation
         * (bilinearInterpolate injected above) plus the dead-band / clamp logic.
         */
        function getRegimeMultiplier(H, PE) {
            if (H == null || PE == null) return 1.0;
            // NOTE: peNodes is the canonical option name read by
            // bilinearInterpolate; a pNodes key silently falls back to the
            // inline defaults.
            return bilinearInterpolate(H, PE, REGIME_TABLE, { hNodes: H_NODES, peNodes: P_NODES });
        }

        let currentRegimeSensitivity = data.regimeSensitivity ?? ma.regimeSensitivity;

        const currentKalmanVelocityPct = new Array(data.dates.length).fill(null);
        const currentLatchedSignals = new Array(data.dates.length).fill(null);
        const dynamicAmaOff      = new Array(data.dates.length).fill(null);
        const dynamicAmaSlopePct = new Array(data.dates.length).fill(null);
        const dynamicKalOff      = new Array(data.dates.length).fill(null);
        const combinedOff     = new Array(data.dates.length).fill(null);
        const combinedSell    = new Array(data.dates.length).fill(null);
        const combinedBuy     = new Array(data.dates.length).fill(null);
        const echoCombinedOff = new Array(data.dates.length).fill(null);
        const echoCombinedSell = new Array(data.dates.length).fill(null);
        const echoCombinedBuy  = new Array(data.dates.length).fill(null);
        const currentMults    = new Array(data.dates.length).fill(null);
        let currentOutputAxisMax = 0.5;
        let dynamicClipThreshold = Infinity;

        // Shared Kalman velocity smoothing (smoothKalmanVelocityPoint /
        // buildKalmanVelocitySeries / resolveKalmanVelocitySmoothingConfig /
        // computeAbsolutePercentileThreshold injected above).
        function recalcKalmanVelocity() {
            const rawSeries = data.kalmanVelocityPctRaw || data.kalmanVelocityPct;
            const dispSeries = data.kalmanDisplacementPct;
            const points = new Array(data.dates.length).fill(null);
            for (let i = 0; i < data.dates.length; i++) {
                points[i] = { velocityPct: rawSeries[i], displacementPct: dispSeries[i] };
            }
            const smoothed = buildKalmanVelocitySeries(points, {
                kalmanSmoothPct: currentKalmanSmoothPct,
                kalmanDispScaleMult: currentKalmanDispScaleMult,
                kalmanDispThresholdMult: currentKalmanDispThresholdMult,
                kalmanSmoothSpanPct: currentKalmanSmoothSpanPct,
            });
            for (let i = 0; i < data.dates.length; i++) {
                currentKalmanVelocityPct[i] = smoothed[i] ?? null;
            }
        }

        function recalcKalmanClipThreshold() {
            currentKalClipThreshold = computeAbsolutePercentileThreshold(
                currentKalmanVelocityPct,
                currentClipPct,
                Infinity
            );
        }

        function signalDirectionForIndex(i) {
            const sig = data.signals[i];
            if (!sig) return 0;
            if (sig.includes('BULL')) return 1;
            if (sig.includes('BEAR')) return -1;
            return 0;
        }

        function directionToSignal(dir) {
            if (dir > 0) return 'BULLISH_DISPLACEMENT';
            if (dir < 0) return 'BEARISH_DISPLACEMENT';
            return 'NEUTRAL';
        }

        function recalcLatchedSignals() {
            const confirmBars = Math.max(SR.signalConfirmBars[0], Math.min(SR.signalConfirmBars[1], currentSignalConfirmBars));
            if (confirmBars === 0) {
                for (let i = 0; i < data.dates.length; i++) {
                    currentLatchedSignals[i] = data.signals[i] || null;
                }
                return;
            }
            let latchedDir = 0;
            let pendingDir = 0;
            let pendingCount = 0;

            for (let i = 0; i < data.dates.length; i++) {
                const raw = data.signals[i];
                const echoDir = signalDirectionForIndex(i);

                if (raw == null) {
                    currentLatchedSignals[i] = null;
                    pendingDir = 0;
                    pendingCount = 0;
                    continue;
                }

                if (echoDir === 0) {
                    currentLatchedSignals[i] = directionToSignal(latchedDir);
                    continue;
                }

                if (latchedDir === 0) {
                    latchedDir = echoDir;
                    pendingDir = 0;
                    pendingCount = 0;
                    currentLatchedSignals[i] = directionToSignal(latchedDir);
                    continue;
                }

                if (echoDir === latchedDir) {
                    pendingDir = 0;
                    pendingCount = 0;
                    currentLatchedSignals[i] = directionToSignal(latchedDir);
                    continue;
                }

                if (pendingDir !== echoDir) {
                    pendingDir = echoDir;
                    pendingCount = 1;
                } else {
                    pendingCount++;
                }

                if (pendingCount >= confirmBars) {
                    latchedDir = echoDir;
                    pendingDir = 0;
                    pendingCount = 0;
                }

                currentLatchedSignals[i] = directionToSignal(latchedDir);
            }
        }

        function recalcInputs() {
            recalcKalmanVelocity();
            recalcKalmanClipThreshold();
            recalcLatchedSignals();
            const lb = currentLookbackBars;
            const amaErWarmup = Math.max(0, Number.isFinite(data.amaErPeriod) ? Math.ceil(data.amaErPeriod) : ${JSON.stringify(MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY as keyof typeof MARKET_ADAPTER.AMAS].erPeriod)});

            // Recompute clip threshold based on current lookback — canonical
            // implementation (computeAmaSlopeClipThreshold injected above),
            // shared with the live market adapter service. Trailing padded
            // nulls beyond realBarCount are skipped by its finiteness guards.
            dynamicClipThreshold = computeAmaSlopeClipThreshold(currentAmaSource, amaErWarmup, lb, currentClipPct);

            // Canonical Huber -> EMA slope series, embedded from the same
            // helper the live market adapter calls. alpha 1 = raw Huber.
            const shaped = computeAmaSlopeEmaSeries(currentAmaSource, amaErWarmup, lb, currentAmaSlopeEmaAlpha);
            for (let i = 0; i < data.dates.length; i++) {
                dynamicAmaSlopePct[i] = i < data.realBarCount ? (shaped[i] ?? null) : null;
            }
        }

        function recalcWeights() {
            // Normalize each channel by the configured clamp so alpha remains a pure ratio knob.
            // Gain then scales the blended output linearly after the dead-band decision.
            currentOutputAxisMax = Math.max(0.5, OUTPUT_CLAMP);
            const outputThreshold = currentMinOutputThreshold;
            const n = data.realBarCount;

            // Per-bar regime multiplier (display + pipeline input)
            for (let i = 0; i < data.dates.length; i++) {
                if (i >= n) { currentMults[i] = null; continue; }
                const baseMult = getRegimeMultiplier(data.hurstArr[i], data.peArr[i]);
                // Match the live regime gate exactly: apply the sensitivity
                // exponent, clamp to 1.0 (dampen-only), round the per-bar series
                // to 3 decimals, then apply the absolute-threshold dead-band.
                const rawMult = roundToN(Math.min(Math.pow(baseMult, currentRegimeSensitivity), 1.0), 1000);
                currentMults[i] = Math.abs(rawMult - 1.0) >= ABSOLUTE_THRESHOLD ? rawMult : 1.0;
            }

            // Per-bar offset pipeline — canonical implementation (computeDynamicWeightSeries
            // injected above), shared with the live market adapter service.
            const res = computeDynamicWeightSeries({
                amaValues: currentAmaSource,
                kalmanVelocityPct: currentKalmanVelocityPct,
                kalmanDisplacementPct: data.kalmanDisplacementPct,
                kalmanIsReady: data.kalmanIsReady,
                regimeMultipliers: currentMults,
                // Shaped slope from recalcInputs(): the weight channel uses the
                // same EMA-smoothed series that is plotted above.
                amaSlopePctSeries: dynamicAmaSlopePct,
                lookbackBars: currentLookbackBars,
                amaErPeriod: data.amaErPeriod,
                amaClipThreshold: dynamicClipThreshold,
                kalClipThreshold: currentKalClipThreshold,
                neutralZonePct: currentNz,
                amaMaxSlopePct: currentAmaMaxSlopePct,
                kalmanMaxSlopePct: currentKalmanMaxSlopePct,
                offsetClamp: OUTPUT_CLAMP,
                dispScaleMinPct: currentDispScaleMinPct,
                alpha: currentAlpha,
                dw: currentDw,
                gain: currentGain,
                minOutputThreshold: currentMinOutputThreshold,
                signalConfirmBars: currentSignalConfirmBars,
                clampFinalOutput: false,
            });

            for (let i = 0; i < data.dates.length; i++) {
                if (i >= n) {
                    dynamicAmaOff[i] = null;
                    dynamicKalOff[i] = null;
                    combinedOff[i] = null;
                    combinedSell[i] = null;
                    combinedBuy[i] = null;
                    echoCombinedOff[i] = null;
                    echoCombinedSell[i] = null;
                    echoCombinedBuy[i] = null;
                    continue;
                }
                const aOff = res.amaOffsets[i];
                const kOff = res.kalmanOffsets[i];
                const cOff = res.combinedOffSeries[i];
                const eOff = res.echoedOffSeries[i];
                dynamicAmaOff[i] = aOff;
                // Keep pre-warmup bars as gaps (not flat 0) to match the historical
                // research-chart rendering: the Kalman channel contributes nothing
                // until the analyzer reports ready with a measurable velocity.
                const kalReady = data.kalmanIsReady[i] === true
                    && currentKalmanVelocityPct[i] != null
                    && data.kalmanDisplacementPct[i] != null;
                if (!kalReady) {
                    dynamicKalOff[i] = null;
                    combinedOff[i] = null;
                    combinedSell[i] = null;
                    combinedBuy[i] = null;
                    echoCombinedOff[i] = null;
                    echoCombinedSell[i] = null;
                    echoCombinedBuy[i] = null;
                    continue;
                }
                dynamicKalOff[i] = kOff;
                combinedOff[i] = cOff;
                combinedSell[i] = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, Math.round((STATIC_SELL - cOff) * 100) / 100));
                combinedBuy[i]  = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, Math.round((STATIC_BUY + cOff) * 100) / 100));
                echoCombinedOff[i] = eOff;
                echoCombinedSell[i] = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, Math.round((STATIC_SELL - eOff) * 100) / 100));
                echoCombinedBuy[i]  = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, Math.round((STATIC_BUY + eOff) * 100) / 100));
                currentOutputAxisMax = Math.max(currentOutputAxisMax, Math.abs(cOff), Math.abs(eOff));
            }
        }
        recalcInputs();
        recalcWeights();

        const xMin = data.dates[0];
        const xMax = data.dates[data.dates.length - 1];
        let pendingRange = null;
        let pendingRangeRaf = 0;
        let priceChart, amaChart, kalmanChart, outputChart;
        let charts;

        ${UPLOT_SHARED_SCRIPT}

        ${VIEWPORT_CLIP_SCRIPT}

        ${refreshChartsPreservingZoomFn({
            anchor: 'outputChart?.scales?.x',
            reload: [
                'amaChart.setData([data.dates, dynamicAmaSlopePct], false);',
                'kalmanChart.setData([data.dates, currentKalmanVelocityPct, data.kalmanDisplacementPct], false);',
                'outputChart.setData([data.dates, combinedOff, echoCombinedOff], false);',
            ],
            charts: 'charts',
        })}

        let lastLiveIdx = data.realBarCount - 1;

        function updateLegend(idx) {
            if (idx == null) return;
            lastLiveIdx = idx;

            const price = data.prices[idx];
            const priceEl = document.getElementById('l-price');
            if (price == null) { priceEl.textContent = '-'; priceEl.style.color = '#8b949e'; }
            else { priceEl.textContent = price.toFixed(4); priceEl.style.color = '#58a6ff'; }

            const ama3 = data.ama3Prices[idx];
            const ama3El = document.getElementById('l-ama3');
            if (ama3 == null) { ama3El.textContent = '-'; ama3El.style.color = '#8b949e'; }
            else { ama3El.textContent = ama3.toFixed(4); ama3El.style.color = '#e3b341'; }

            const seedSma = data.amaSeedSmaLine[idx];
            const seedSmaEl = document.getElementById('l-seed-sma');
            if (seedSma == null) { seedSmaEl.textContent = '-'; seedSmaEl.style.color = '#8b949e'; }
            else { seedSmaEl.textContent = seedSma.toFixed(4); seedSmaEl.style.color = '#8b949e'; }

            const sp = dynamicAmaSlopePct[idx];
            const spEl = document.getElementById('l-ama-slope');
            if (sp == null) { spEl.textContent = '-'; spEl.style.color = '#8b949e'; }
            else { spEl.textContent = (sp >= 0 ? '+' : '') + (sp * 10).toFixed(3) + '‰'; spEl.style.color = sp > 0.01 ? '#2ea043' : sp < -0.01 ? '#f85149' : '#8b949e'; }

            const vp = currentKalmanVelocityPct[idx];
            const vpEl = document.getElementById('l-kal-vel');
            if (vp == null) { vpEl.textContent = '-'; vpEl.style.color = '#8b949e'; }
            else { vpEl.textContent = (vp >= 0 ? '+' : '') + vp.toFixed(3) + '%'; vpEl.style.color = vp > 0.01 ? '#2ea043' : vp < -0.01 ? '#f85149' : '#8b949e'; }

            const dp = data.kalmanDisplacementPct[idx];
            const dpEl = document.getElementById('l-kal-disp');
            if (dp == null) { dpEl.textContent = '-'; dpEl.style.color = '#8b949e'; }
            else { dpEl.textContent = (dp >= 0 ? '+' : '') + dp.toFixed(2) + '%'; dpEl.style.color = dp > 0.3 ? '#2ea043' : dp < -0.3 ? '#f85149' : '#8b949e'; }

            const sig = data.signals[idx];
            const echoSig = directionToSignal(signalDirectionForIndex(idx));
            const latchedSig = currentLatchedSignals[idx];
            const sigEl = document.getElementById('l-signal');
            if (!sig) { sigEl.textContent = '-'; sigEl.style.color = '#8b949e'; }
            else if (sig.includes('BULL')) { sigEl.textContent = '\u25b2 BULL'; sigEl.style.color = '#2ea043'; }
            else if (sig.includes('BEAR')) { sigEl.textContent = '\u25bc BEAR'; sigEl.style.color = '#f85149'; }
            else if (sig === 'EQUILIBRIUM') { sigEl.textContent = '\u2248 EQ'; sigEl.style.color = '#58a6ff'; }
            else { sigEl.textContent = '\u25cb NEU'; sigEl.style.color = '#8b949e'; }
            const echoEl = document.getElementById('l-signal-echo');
            if (!echoSig) { echoEl.textContent = '-'; echoEl.style.color = '#8b949e'; }
            else if (echoSig.includes('BULL')) { echoEl.textContent = '\u25b2 BULL'; echoEl.style.color = '#3fb950'; }
            else if (echoSig.includes('BEAR')) { echoEl.textContent = '\u25bc BEAR'; echoEl.style.color = '#ff7b72'; }
            else { echoEl.textContent = '\u25cb NEU'; echoEl.style.color = '#8b949e'; }
            const latchedEl = document.getElementById('l-signal-latched');
            if (!latchedSig) { latchedEl.textContent = '-'; latchedEl.style.color = '#8b949e'; }
            else if (latchedSig.includes('BULL')) { latchedEl.textContent = '\u25b2 BULL'; latchedEl.style.color = '#3fb950'; }
            else if (latchedSig.includes('BEAR')) { latchedEl.textContent = '\u25bc BEAR'; latchedEl.style.color = '#ff7b72'; }
            else if (latchedSig === 'EQUILIBRIUM') { latchedEl.textContent = '\u2248 EQ'; latchedEl.style.color = '#79c0ff'; }
            else { latchedEl.textContent = '\u25cb NEU'; latchedEl.style.color = '#8b949e'; }

            const cRaw = combinedOff[idx];
            const cRawEl = document.getElementById('l-combined-raw');
            if (cRaw == null) { cRawEl.textContent = '-'; cRawEl.style.color = '#8b949e'; }
            else { cRawEl.textContent = (cRaw >= 0 ? '+' : '') + cRaw.toFixed(3); cRawEl.style.color = '#8b949e'; }

            const cEcho = echoCombinedOff[idx];
            const cEchoEl = document.getElementById('l-combined-echo');
            if (cEcho == null) { cEchoEl.textContent = '-'; cEchoEl.style.color = '#8b949e'; }
            else { cEchoEl.textContent = (cEcho >= 0 ? '+' : '') + cEcho.toFixed(3); cEchoEl.style.color = cEcho > 0.01 ? '#2ea043' : cEcho < -0.01 ? '#f85149' : '#8b949e'; }

            const mult = currentMults[idx];
            const multEl = document.getElementById('l-mult');
            if (mult == null) { multEl.textContent = '-'; }
            else { multEl.textContent = 'x' + mult.toFixed(2); multEl.style.color = mult > 1.05 ? '#3fb950' : mult < 0.95 ? '#f85149' : '#d2a8ff'; }

            document.getElementById('l-sell').textContent = echoCombinedSell[idx] != null ? echoCombinedSell[idx].toFixed(2) : '-';
            document.getElementById('l-buy').textContent  = echoCombinedBuy[idx]  != null ? echoCombinedBuy[idx].toFixed(2) : '-';
        }

        function makeSignalBgHook(scaleKey) {
            return u => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();
                ctx.globalCompositeOperation = 'destination-over';
                // Cull segments that cannot intersect the viewport so we skip
                // their (expensive, destination-over) fillRect and valToPos work.
                const xScale = u.scales.x || {};
                const smin = xScale.min, smax = xScale.max;
                const canCull = Number.isFinite(smin) && Number.isFinite(smax);
                let i = 0;
                while (i < data.signals.length) {
                    const s = currentLatchedSignals[i] || data.signals[i];
                    if (!s || i >= data.realBarCount) { i++; continue; }
                    const isBull = s.includes('BULL');
                    const isBear = s.includes('BEAR');
                    let j = i + 1;
                    while (j < data.realBarCount) {
                        const sj = currentLatchedSignals[j] || data.signals[j];
                        if (sj !== s) break;
                        j++;
                    }
                    if (canCull) {
                        // A run that reaches the last real bar is drawn all the way
                        // to bbox.right, so it is visible for any viewport past its
                        // start (never cull it on the right). Only runs that end at a
                        // real bar can be entirely left of the viewport.
                        const reachesRightEdge = j >= data.realBarCount;
                        const segEnd = reachesRightEdge ? Infinity : data.dates[j];
                        if (segEnd < smin) { i = j; continue; }
                        if (data.dates[i] > smax) break;
                    }
                    const x0 = u.valToPos(data.dates[i], 'x', true);
                    const x1 = j < data.realBarCount ? u.valToPos(data.dates[j], 'x', true) : bbox.left + bbox.width;
                    if (isBull) { ctx.fillStyle = 'rgba(46,160,67,0.06)'; ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height); }
                    else if (isBear) { ctx.fillStyle = 'rgba(248,81,73,0.06)'; ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height); }
                    i = j;
                }
                // Neutral zone band
                if (scaleKey) {
                    const nzY = u.valToPos(currentNz, scaleKey, true);
                    const nzYNeg = u.valToPos(-currentNz, scaleKey, true);
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.fillStyle = 'rgba(139,148,158,0.06)';
                    ctx.fillRect(bbox.left, Math.min(nzY, nzYNeg), bbox.width, Math.abs(nzYNeg - nzY));
                }
                ctx.restore();
            };
        }

        function makePctFillHook(values, scaleKey, posColor, negColor, strokeStyle = 'rgba(255,255,255,0.35)') {
            return u => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();
                const zeroY = u.valToPos(0, scaleKey, true);
                const path = new Path2D();
                let inSeg = false, lastX = 0;
                const [lo, hi] = visibleBarRange(u, values.length);
                for (let i = lo; i <= hi; i++) {
                    const v = values[i];
                    if (v === null) { if (inSeg) { path.lineTo(lastX, zeroY); inSeg = false; } continue; }
                    const x = u.valToPos(data.dates[i], 'x', true);
                    const y = u.valToPos(v, scaleKey, true);
                    if (!inSeg) { path.moveTo(x, zeroY); path.lineTo(x, y); inSeg = true; }
                    else path.lineTo(x, y);
                    lastX = x;
                }
                if (inSeg) path.lineTo(lastX, zeroY);
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, zeroY - bbox.top); ctx.clip();
                ctx.fillStyle = posColor; ctx.fill(path);
                ctx.restore();
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, zeroY, bbox.width, bbox.top + bbox.height - zeroY); ctx.clip();
                ctx.fillStyle = negColor; ctx.fill(path);
                ctx.restore();
                if (strokeStyle) {
                    ctx.strokeStyle = strokeStyle; ctx.lineWidth = 1; ctx.stroke(path);
                    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.moveTo(bbox.left, zeroY); ctx.lineTo(bbox.left + bbox.width, zeroY); ctx.stroke();
                }
                ctx.restore();
            };
        }

        function makeClampLineHook(scaleKey, clampValue, label = 'clamp') {
            return u => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();

                const y = u.valToPos(clampValue, scaleKey, true);
                ctx.strokeStyle = '#a371f7';
                ctx.shadowColor = 'rgba(163,113,247,0.65)';
                ctx.shadowBlur = 5;
                ctx.lineWidth = 1.5;
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(bbox.left, y);
                ctx.lineTo(bbox.left + bbox.width, y);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.shadowBlur = 0;
                ctx.shadowColor = 'transparent';

                if (label) {
                    ctx.font = 'bold 10px Segoe UI, sans-serif';
                    ctx.textBaseline = 'middle';
                    const textW = ctx.measureText(label).width + 8;
                    const textX = Math.max(bbox.left + 4, bbox.left + bbox.width - textW - 2);
                    const textY = y - 8;
                    ctx.fillStyle = 'rgba(11,14,20,0.82)';
                    ctx.fillRect(textX - 4, textY - 7, textW, 14);
                    ctx.fillStyle = '#a371f7';
                    ctx.fillText(label, textX, textY);
                }

                ctx.restore();
            };
        }

        function makeClampPairHooks(scaleKey, clampValue) {
            return [
                makeClampLineHook(scaleKey, clampValue, 'clamp ' + clampValue.toFixed(2)),
                makeClampLineHook(scaleKey, -clampValue, 'clamp -' + clampValue.toFixed(2)),
            ];
        }

        const cursorCfg = ${makeCursorConfig()};

        ${formatTimeLabelFn()}

        function makeTimeAxis(showLabels = false) {
            return {
                show: true,
                stroke: '#ffffff',
                grid: { stroke: '#1c2128' },
                ticks: { stroke: '#30363d', width: 1 },
                size: showLabels ? 24 : 0,
                font: '11px Segoe UI, sans-serif',
                values: showLabels ? (u, vals) => {
                    const xScale = u.scales.x || {};
                    const spanSec = Number.isFinite(xScale.min) && Number.isFinite(xScale.max)
                        ? Math.max(0, xScale.max - xScale.min)
                        : (xMax - xMin);
                    return vals.map((ts) => formatTimeLabel(ts, spanSec));
                } : () => [],
            };
        }

        function init() {
            // Force all sliders to match JS state — overrides browser form-restore memory
            document.getElementById('alpha-slider').value = Math.round(currentAlpha * 100);
            document.getElementById('ama-ms-slider').value = Math.round((Math.log(currentAmaMaxSlopePct) - AMA_MS_LOG_MIN) / (AMA_MS_LOG_MAX - AMA_MS_LOG_MIN) * 1000);
            document.getElementById('kal-ms-slider').value = Math.round((Math.log(currentKalmanMaxSlopePct) - KAL_MS_LOG_MIN) / (KAL_MS_LOG_MAX - KAL_MS_LOG_MIN) * 1000);
            document.getElementById('th-slider').value = Math.round(currentMinOutputThreshold * 100);
            document.getElementById('th-value').textContent = currentMinOutputThreshold.toFixed(2);
            document.getElementById('gain-slider').value = gainValToSlider(currentGain);
            document.getElementById('kf-slider').value = currentKalmanSmoothPct;
            document.getElementById('kfd-slider').value = Math.round(currentKalmanDispScaleMult * 100);
            document.getElementById('dsp-slider').value = Math.round(currentDispScaleMinPct * 100);
            document.getElementById('kdt-slider').value = Math.round(currentKalmanDispThresholdMult * 100);
            document.getElementById('kfs-slider').value = currentKalmanSmoothSpanPct;
            document.getElementById('cf-slider').value = currentSignalConfirmBars;
            document.getElementById('clip-slider').value = currentClipPct;
            document.getElementById('ema-slider').value = emaValToSlider(currentAmaSlopeEmaAlpha);
            document.getElementById('ema-value').textContent = formatEmaLabel(currentAmaSlopeEmaAlpha);
            document.getElementById('nz-slider').value = Math.round(currentNz * 100);
            document.getElementById('lb-slider').value = lbValToSlider(currentLookbackBars);

            const priceEl  = document.getElementById('price-panel');
            const amaEl    = document.getElementById('ama-panel');
            const kalmanEl = document.getElementById('kalman-panel');
            const outputEl = document.getElementById('output-panel');


            priceChart = new uPlot({
                width: priceEl.offsetWidth, height: priceEl.offsetHeight,
                padding: [4, 8, 0, 4], select: { show: false }, legend: { show: false },
                scales: {
                    x: { time: true },
                    y: { auto: true, distr: 3, log: 10, range: (u, min, max) => [min * 0.9, max * 1.1] }
                },
                series: [
                    { label: 'Time' },
                    { label: 'Price', stroke: '#58a6ff', width: 1.5, scale: 'y', points: { show: false } },
                    { label: '${amaLabel}',  stroke: '#e3b341', width: 1.5, scale: 'y', points: { show: false } },
                    { label: 'Seed SMA', stroke: '#8b949e', width: 1.5, dash: [4, 4], scale: 'y', points: { show: false } },
                ],
                axes: [
                    makeTimeAxis(false),
                    { scale: 'y', stroke: '#ffffff', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      splits: logAxisSplits,
                      values: (u, v) => v.map(x => x != null ? x.toFixed(4) : ''), }
                ],
                cursor: cursorCfg,
                hooks: { draw: [makeSignalBgHook('y')] }
            }, [data.dates, data.prices, data.ama3Prices, data.amaSeedSmaLine], document.getElementById('price-chart'));

            amaChart = new uPlot({
                width: amaEl.offsetWidth, height: amaEl.offsetHeight,
                padding: [4, 8, 0, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, p: { auto: true } },
                series: [
                    { label: 'Time' },
                    { label: 'Slope‰', stroke: '#f0a000', width: 2, scale: 'p', points: { show: false } },
                ],
                axes: [
                    makeTimeAxis(false),
                    { scale: 'p', stroke: '#ffffff', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? (x >= 0 ? '+' : '') + (x * 10).toFixed(2) + '‰' : '') }
                ],
                cursor: cursorCfg,
                hooks: { draw: [makePctFillHook(dynamicAmaSlopePct, 'p', 'rgba(46,160,67,0.20)', 'rgba(248,81,73,0.20)'), makeSignalBgHook('p')] }
            }, [data.dates, dynamicAmaSlopePct], document.getElementById('ama-chart'));

            kalmanChart = new uPlot({
                width: kalmanEl.offsetWidth, height: kalmanEl.offsetHeight,
                padding: [4, 8, 0, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, v: { auto: true } },
                series: [
                    { label: 'Time' },
                    { label: 'Vel%', stroke: '#d2a8ff', width: 2, scale: 'v', points: { show: false } },
                    { label: 'Disp%', stroke: '#79c0ff', width: 1.5, dash: [6, 3], scale: 'v', points: { show: false } },
                ],
                axes: [
                    makeTimeAxis(false),
                    { scale: 'v', stroke: '#ffffff', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? (x >= 0 ? '+' : '') + x.toFixed(1) + '%' : '') }
                ],
                cursor: cursorCfg,
                hooks: { draw: [
                    makePctFillHook(currentKalmanVelocityPct, 'v', 'rgba(210,168,255,0.18)', 'rgba(210,168,255,0.18)'),
                    makeSignalBgHook('v')
                ] }
            }, [data.dates, currentKalmanVelocityPct, data.kalmanDisplacementPct], document.getElementById('kalman-chart'));

            outputChart = new uPlot({
                width: outputEl.offsetWidth, height: outputEl.offsetHeight,
                padding: [20, 8, 0, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, ow: { auto: true, range: (u, min, max) => {
                    const m = 0.5;
                    const pad = (max - min) * 0.1 || 0.02;
                    return [Math.min(min - pad, -m), Math.max(max + pad, m)];
                }}},
                series: [
                    { label: 'Time' },
                    { label: 'RawOff', stroke: 'transparent', width: 0, scale: 'ow', points: { show: false } },
                    { label: 'EchoOff', stroke: 'transparent', width: 0, scale: 'ow', points: { show: false } }
                ],
                axes: [
                    makeTimeAxis(true),
                    { scale: 'ow', stroke: '#ffffff', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? (x >= 0 ? '+' : '') + x.toFixed(2) : ''),
                      splits: () => { const m = Math.max(0.5, currentOutputAxisMax || 0.5); return [-m, -m/2, 0, m/2, m]; } }
                ],
                cursor: cursorCfg,
                hooks: { draw: [
                    makePctFillHook(combinedOff, 'ow', 'rgba(108,117,125,0.08)', 'rgba(108,117,125,0.06)', null),
                    makePctFillHook(echoCombinedOff, 'ow', 'rgba(46,160,67,0.18)', 'rgba(248,81,73,0.18)', null),
                    ...makeClampPairHooks('ow', OUTPUT_CLAMP)
                ] }
            }, [data.dates, combinedOff, echoCombinedOff], document.getElementById('output-chart'));

            charts = [priceChart, amaChart, kalmanChart, outputChart];
            ${bindHoverStateFn()}
            ${wireChartEvents('charts', 'updateLegend', 'lastLiveIdx')}

        function onSliderChange() {
            recalcInputs();
            recalcWeights();
            refreshChartsPreservingZoom();
        }

            document.getElementById('alpha-slider').addEventListener('input', (e) => {
                currentAlpha = parseInt(e.target.value, 10) / 100;
                document.getElementById('alpha-value').textContent = currentAlpha.toFixed(2);
                recalcWeights();
                refreshChartsPreservingZoom();
            });

            document.getElementById('dw-slider').addEventListener('input', (e) => {
                currentDw = parseInt(e.target.value, 10) / 100;
                document.getElementById('dw-value').textContent = currentDw.toFixed(2);
                onSliderChange();
            });

            document.getElementById('ama-ms-slider').addEventListener('input', (e) => {
                currentAmaMaxSlopePct = amaMsSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('ama-ms-value').textContent = currentAmaMaxSlopePct.toFixed(4);
                onSliderChange();
            });

            document.getElementById('kal-ms-slider').addEventListener('input', (e) => {
                currentKalmanMaxSlopePct = kalMsSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('kal-ms-value').textContent = currentKalmanMaxSlopePct.toFixed(2);
                onSliderChange();
            });

            document.getElementById('gain-slider').addEventListener('input', (e) => {
                currentGain = gainSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('gain-value').textContent = currentGain.toFixed(3);
                onSliderChange();
            });

            document.getElementById('th-slider').addEventListener('input', (e) => {
                currentMinOutputThreshold = Math.min(Math.max(parseInt(e.target.value, 10) / 100, SR.minOutputThreshold[0]), SR.minOutputThreshold[1]);
                document.getElementById('th-value').textContent = currentMinOutputThreshold.toFixed(2);
                recalcWeights();
                refreshChartsPreservingZoom();
            });

            document.getElementById('kf-slider').addEventListener('input', (e) => {
                currentKalmanSmoothPct = parseInt(e.target.value, 10);
                document.getElementById('kf-value').textContent = currentKalmanSmoothPct + '%';
                onSliderChange();
            });

            document.getElementById('kfd-slider').addEventListener('input', (e) => {
                currentKalmanDispScaleMult = parseInt(e.target.value, 10) / 100;
                document.getElementById('kfd-value').textContent = currentKalmanDispScaleMult.toFixed(2) + 'x';
                onSliderChange();
            });

            document.getElementById('dsp-slider').addEventListener('input', (e) => {
                currentDispScaleMinPct = parseInt(e.target.value, 10) / 100;
                document.getElementById('dsp-value').textContent = currentDispScaleMinPct.toFixed(2) + 'x';
                onSliderChange();
            });

            document.getElementById('kdt-slider').addEventListener('input', (e) => {
                currentKalmanDispThresholdMult = parseInt(e.target.value, 10) / 100;
                document.getElementById('kdt-value').textContent = currentKalmanDispThresholdMult.toFixed(2) + 'x';
                onSliderChange();
            });

            document.getElementById('kfs-slider').addEventListener('input', (e) => {
                currentKalmanSmoothSpanPct = parseInt(e.target.value, 10);
                document.getElementById('kfs-value').textContent = currentKalmanSmoothSpanPct + '%';
                onSliderChange();
            });

            document.getElementById('cf-slider').addEventListener('input', (e) => {
                currentSignalConfirmBars = parseInt(e.target.value, 10);
                document.getElementById('cf-value').textContent = currentSignalConfirmBars;
                onSliderChange();
            });

            document.getElementById('clip-slider').addEventListener('input', (e) => {
                currentClipPct = parseInt(e.target.value, 10);
                if (currentClipPct === 0) {
                    currentKalClipThreshold = Infinity;
                } else {
                    // AMA clip threshold for clipPct>0 comes from the canonical
                    // computeAmaSlopeClipThreshold inside recalcInputs() —
                    // no percentile-table store needed here.
                    recalcKalmanClipThreshold();
                }
                document.getElementById('clip-value').textContent = currentClipPct + '%';
                onSliderChange();
            });

            document.getElementById('ema-slider').addEventListener('input', (e) => {
                currentAmaSlopeEmaAlpha = emaSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('ema-value').textContent = formatEmaLabel(currentAmaSlopeEmaAlpha);
                onSliderChange();
            });

            document.getElementById('nz-slider').addEventListener('input', (e) => {
                currentNz = parseInt(e.target.value, 10) / 100;
                document.getElementById('nz-value').textContent = currentNz.toFixed(2);
                onSliderChange();
            });

            document.getElementById('lb-slider').addEventListener('input', (e) => {
                currentLookbackBars = lbSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('lb-value').textContent = currentLookbackBars;
                onSliderChange();
            });

            document.getElementById('regime-slider').addEventListener('input', (e) => {
                currentRegimeSensitivity = parseInt(e.target.value, 10) / 100;
                document.getElementById('regime-value').textContent = currentRegimeSensitivity.toFixed(2);
                recalcWeights();
                refreshChartsPreservingZoom();
            });

function applyParams(p, btn) {
                if (typeof p !== 'object' || p === null) throw new Error('not an object');
                if (p.alpha != null) {
                    currentAlpha = Math.max(SR.alpha[0], Math.min(SR.alpha[1], p.alpha));
                    document.getElementById('alpha-slider').value = Math.round(currentAlpha * 100);
                    document.getElementById('alpha-value').textContent = currentAlpha.toFixed(2);
                }
                if (p.dispWeight != null) {
                    currentDw = Math.max(SR.dispWeight[0], Math.min(SR.dispWeight[1], p.dispWeight));
                    document.getElementById('dw-slider').value = Math.round(currentDw * 100);
                    document.getElementById('dw-value').textContent = currentDw.toFixed(2);
                }
                if (p.amaMaxSlopePct != null) {
                    currentAmaMaxSlopePct = Math.max(SR.amaMaxSlopePct[0], Math.min(SR.amaMaxSlopePct[1], p.amaMaxSlopePct));
                    document.getElementById('ama-ms-slider').value = Math.round((Math.log(currentAmaMaxSlopePct) - AMA_MS_LOG_MIN) / (AMA_MS_LOG_MAX - AMA_MS_LOG_MIN) * 1000);
                    document.getElementById('ama-ms-value').textContent = currentAmaMaxSlopePct.toFixed(4);
                }
                if (p.kalmanMaxSlopePct != null) {
                    currentKalmanMaxSlopePct = Math.max(SR.kalmanMaxSlopePct[0], Math.min(SR.kalmanMaxSlopePct[1], p.kalmanMaxSlopePct));
                    document.getElementById('kal-ms-slider').value = Math.round((Math.log(currentKalmanMaxSlopePct) - KAL_MS_LOG_MIN) / (KAL_MS_LOG_MAX - KAL_MS_LOG_MIN) * 1000);
                    document.getElementById('kal-ms-value').textContent = currentKalmanMaxSlopePct.toFixed(2);
                }
                if (p.gain != null) {
                    currentGain = Math.max(SR.gain[0], Math.min(SR.gain[1], p.gain));
                    document.getElementById('gain-slider').value = gainValToSlider(currentGain);
                    document.getElementById('gain-value').textContent = currentGain.toFixed(3);
                }
                if (p.minOutputThreshold != null) {
                    currentMinOutputThreshold = Math.max(SR.minOutputThreshold[0], Math.min(SR.minOutputThreshold[1], p.minOutputThreshold));
                    document.getElementById('th-slider').value = Math.round(currentMinOutputThreshold * 100);
                    document.getElementById('th-value').textContent = currentMinOutputThreshold.toFixed(2);
                }
                if (p.kalmanSmoothPct != null) {
                currentKalmanSmoothPct = Math.max(SR.kalmanSmoothPct[0], Math.min(SR.kalmanSmoothPct[1], Math.round(p.kalmanSmoothPct)));
                    document.getElementById('kf-slider').value = currentKalmanSmoothPct;
                    document.getElementById('kf-value').textContent = currentKalmanSmoothPct + '%';
                }
                if (p.kalmanDispScaleMult != null) {
                    currentKalmanDispScaleMult = Math.max(SR.kalmanDispScaleMult[0], Math.min(SR.kalmanDispScaleMult[1], p.kalmanDispScaleMult));
                    document.getElementById('kfd-slider').value = Math.round(currentKalmanDispScaleMult * 100);
                    document.getElementById('kfd-value').textContent = currentKalmanDispScaleMult.toFixed(2) + 'x';
                }
                if (p.dispScaleMinPct != null) {
                    currentDispScaleMinPct = Math.max(SR.dispScaleMinPct[0], Math.min(SR.dispScaleMinPct[1], p.dispScaleMinPct));
                    document.getElementById('dsp-slider').value = Math.round(currentDispScaleMinPct * 100);
                    document.getElementById('dsp-value').textContent = currentDispScaleMinPct.toFixed(2) + 'x';
                }
                if (p.kalmanDispThresholdMult != null) {
                    currentKalmanDispThresholdMult = Math.max(SR.kalmanDispThresholdMult[0], Math.min(SR.kalmanDispThresholdMult[1], p.kalmanDispThresholdMult));
                    document.getElementById('kdt-slider').value = Math.round(currentKalmanDispThresholdMult * 100);
                    document.getElementById('kdt-value').textContent = currentKalmanDispThresholdMult.toFixed(2) + 'x';
                }
                if (p.kalmanSmoothSpanPct != null) {
                    currentKalmanSmoothSpanPct = Math.max(SR.kalmanSmoothSpanPct[0], Math.min(SR.kalmanSmoothSpanPct[1], Math.round(p.kalmanSmoothSpanPct)));
                    document.getElementById('kfs-slider').value = currentKalmanSmoothSpanPct;
                    document.getElementById('kfs-value').textContent = currentKalmanSmoothSpanPct + '%';
                }
                if (p.signalConfirmBars != null) {
                    currentSignalConfirmBars = Math.max(SR.signalConfirmBars[0], Math.min(SR.signalConfirmBars[1], Math.round(p.signalConfirmBars)));
                    document.getElementById('cf-slider').value = currentSignalConfirmBars;
                    document.getElementById('cf-value').textContent = currentSignalConfirmBars;
                }
                if (p.clipPct != null) {
                    currentClipPct = Math.max(SR.clipPct[0], Math.min(SR.clipPct[1], Math.round(p.clipPct)));
                    document.getElementById('clip-slider').value = currentClipPct;
                    document.getElementById('clip-value').textContent = currentClipPct + '%';
                    if (currentClipPct === 0) {
                        currentKalClipThreshold = Infinity;
                    } else {
                        recalcKalmanClipThreshold();
                    }
                }
                if (p.amaSlopeEmaAlpha != null) {
                    currentAmaSlopeEmaAlpha = Math.max(SR.amaSlopeEmaAlpha[0], Math.min(SR.amaSlopeEmaAlpha[1], p.amaSlopeEmaAlpha));
                    document.getElementById('ema-slider').value = emaValToSlider(currentAmaSlopeEmaAlpha);
                    document.getElementById('ema-value').textContent = formatEmaLabel(currentAmaSlopeEmaAlpha);
                }
                if (p.neutralZonePct != null) {
                    currentNz = Math.max(SR.neutralZonePct[0], Math.min(SR.neutralZonePct[1], p.neutralZonePct));
                    document.getElementById('nz-slider').value = Math.round(currentNz * 100);
                    document.getElementById('nz-value').textContent = currentNz.toFixed(2);
                }
                if (p.regimeSensitivity != null) {
                    currentRegimeSensitivity = Math.max(SR.regimeSensitivity[0], Math.min(SR.regimeSensitivity[1], p.regimeSensitivity));
                    document.getElementById('regime-slider').value = Math.round(currentRegimeSensitivity * 100);
                    document.getElementById('regime-value').textContent = currentRegimeSensitivity.toFixed(2);
                }
                if (p.lookbackBars != null) {
                    currentLookbackBars = Math.max(SR.lookbackBars[0], Math.min(SR.lookbackBars[1], Math.round(p.lookbackBars)));
                    document.getElementById('lb-slider').value = lbValToSlider(currentLookbackBars);
                    document.getElementById('lb-value').textContent = currentLookbackBars;
                }
                recalcInputs();
                recalcWeights();
                refreshChartsPreservingZoom();
                if (btn) { btn.textContent = 'pasted!'; btn.classList.add('pasted'); setTimeout(() => { btn.textContent = 'paste'; btn.classList.remove('pasted'); }, 1500); }
            }

            let _confirmPending = null;
            function showConfirm(p, btn) {
                _confirmPending = { p, btn };
                const labels = {
                    alpha: 'alpha',
                    amaMaxSlopePct: 'amaS%',
                    kalmanMaxSlopePct: 'kalS%',
                    minOutputThreshold: 'th%',
                    gain: 'gain',
                    kalmanSmoothPct: 'kf',
                    kalmanDispScaleMult: 'kfd',
                    dispScaleMinPct: 'dsp',
                    kalmanDispThresholdMult: 'kdt',
                    kalmanSmoothSpanPct: 'kfs',
                    signalConfirmBars: 'cf',
                    clipPct: 'clip%',
                    amaSlopeEmaAlpha: 'ema',
                    neutralZonePct: 'nz%',
                    regimeSensitivity: 'regime',
                    dispWeight: 'dw',
                    lookbackBars: 'lb',
                };
                document.getElementById('paste-confirm-vals').innerHTML = Object.entries(labels)
                    .filter(([k]) => p[k] != null)
                    .map(([k, label]) => label + ': <span>' + p[k] + '</span>')
                    .join('<br>');
                const popup = document.getElementById('paste-confirm');
                popup.style.display = 'block';
                const r = btn.getBoundingClientRect();
                const pw = popup.offsetWidth, ph = popup.offsetHeight;
                let top = r.top - ph - 6;
                let left = r.right - pw;
                if (top < 4) top = r.bottom + 6;
                if (left < 4) left = 4;
                popup.style.top  = top + 'px';
                popup.style.left = left + 'px';
            }

            document.getElementById('paste-confirm-apply').addEventListener('click', () => {
                document.getElementById('paste-confirm').style.display = 'none';
                if (_confirmPending) { applyParams(_confirmPending.p, _confirmPending.btn); _confirmPending = null; }
            });
            document.getElementById('paste-confirm-cancel').addEventListener('click', () => {
                document.getElementById('paste-confirm').style.display = 'none';
                _confirmPending = null;
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && document.getElementById('paste-confirm').style.display !== 'none') {
                    document.getElementById('paste-confirm').style.display = 'none';
                    _confirmPending = null;
                }
            });

            const LS_KEY = 'dw_research_params';

            // Factory defaults captured server-side; the reset button restores
            // every knob to these values.
            const RESET_PARAMS = ${JSON.stringify({
                alpha: defaultAlpha,
                amaMaxSlopePct: defaultAmaMaxSlopePct,
                kalmanMaxSlopePct: defaultKalmanMaxSlopePct,
                minOutputThreshold: defaultMinOutputThreshold,
                gain: defaultGain,
                kalmanSmoothPct: defaultKalmanSmoothPct,
                kalmanDispScaleMult: defaultKalmanDispScaleMult,
                dispScaleMinPct: defaultDispScaleMinPct,
                kalmanDispThresholdMult: defaultKalmanDispThresholdMult,
                kalmanSmoothSpanPct: defaultKalmanSmoothSpanPct,
                signalConfirmBars: defaultSignalConfirmBars,
                clipPct: defaultClipPct,
                amaSlopeEmaAlpha: clampedEma,
                neutralZonePct: defaultNeutralZone,
                regimeSensitivity: defaultRegimeSensitivity,
                dispWeight: defaultDispWeight,
                lookbackBars,
            })};

            document.getElementById('copy-params-btn').addEventListener('click', () => {
                const btn = document.getElementById('copy-params-btn');
                const params = {
                    alpha:             +currentAlpha.toFixed(2),
                    amaMaxSlopePct:    +currentAmaMaxSlopePct.toFixed(4),
                    kalmanMaxSlopePct: +currentKalmanMaxSlopePct.toFixed(2),
                    minOutputThreshold: +currentMinOutputThreshold.toFixed(2),
                    gain:              +currentGain.toFixed(3),
                    kalmanSmoothPct:   currentKalmanSmoothPct,
                    kalmanDispScaleMult: +currentKalmanDispScaleMult.toFixed(2),
                    dispScaleMinPct:   +currentDispScaleMinPct.toFixed(2),
                    kalmanDispThresholdMult: +currentKalmanDispThresholdMult.toFixed(2),
                    kalmanSmoothSpanPct: currentKalmanSmoothSpanPct,
                    signalConfirmBars: currentSignalConfirmBars,
                    clipPct:           currentClipPct,
                    // Keep full precision: 2/101 rounds to 0.020 at 3 decimals.
                    amaSlopeEmaAlpha:  currentAmaSlopeEmaAlpha,
                    neutralZonePct:    +currentNz.toFixed(3),
                    regimeSensitivity: +currentRegimeSensitivity.toFixed(2),
                    dispWeight:        +currentDw.toFixed(2),
                    lookbackBars:      currentLookbackBars,
                };
                const json = JSON.stringify(params, null, 2);
                localStorage.setItem(LS_KEY, json);
                navigator.clipboard.writeText(json).catch(() => {});
                btn.textContent = 'copied!';
                btn.classList.add('copied');
                setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1500);
            });

            document.getElementById('paste-params-btn').addEventListener('click', () => {
                const btn = document.getElementById('paste-params-btn');
                const tryParse = (text) => {
                    try { showConfirm(JSON.parse(text), btn); }
                    catch { btn.textContent = 'error'; btn.classList.add('error'); setTimeout(() => { btn.textContent = 'paste'; btn.classList.remove('error'); }, 1500); }
                };
                // Use localStorage first (same-tab copy/paste), fallback to Ctrl+V
                const stored = localStorage.getItem(LS_KEY);
                if (stored) {
                    try { showConfirm(JSON.parse(stored), btn); return; } catch {}
                }
                // No localStorage data - use Ctrl+V method
                btn.textContent = 'Ctrl+V…';
                btn.classList.add('pasted');
                const ta = document.createElement('textarea');
                ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;width:1px;height:1px;font-size:16px;';
                document.body.appendChild(ta);
                ta.focus();
                const cleanup = () => { document.body.removeChild(ta); btn.textContent = 'paste'; btn.classList.remove('pasted'); };
                ta.addEventListener('paste', (e) => {
                    const text = (e.clipboardData || window.clipboardData).getData('text');
                    cleanup();
                    tryParse(text);
                }, { once: true });
                ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(); });
                setTimeout(cleanup, 10000);
            });

            document.getElementById('reset-params-btn').addEventListener('click', () => {
                const btn = document.getElementById('reset-params-btn');
                applyParams(RESET_PARAMS);
                btn.textContent = 'reset!';
                btn.classList.add('reset');
                setTimeout(() => { btn.textContent = 'reset'; btn.classList.remove('reset'); }, 1500);
            });
        }

        ${sizeChartsFn([['priceChart', 'price-panel'], ['amaChart', 'ama-panel'], ['kalmanChart', 'kalman-panel'], ['outputChart', 'output-panel']])}

        window.addEventListener('resize', sizeCharts);
        ${zoomResetScript()}

        init();
        requestAnimationFrame(() => { sizeCharts(); updateLegend(lastLiveIdx); });
    </script>
</body>
</html>`;
}

export { generateHTML, CHART_LOOKBACK_BARS_BOUNDS }

