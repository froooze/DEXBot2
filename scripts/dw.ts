#!/usr/bin/env node
'use strict';
/**
 * Usage:
 *   dexbot dw <bot|pool|AssetA/AssetB> [--month N] [--chart <path>] [--feed|--pool|--book]
 *
 * Thin entry for the shared chart-command pipeline in scripts/chart_command.ts
 * (identical fetch/target logic as `dexbot tv`). This command renders through
 * analysis/analyze_dynamic_weight.js — the dynamic-weight research HTML
 * (AMA slope + Kalman blend, Hurst/PE regime gate) instead of a TradingView
 * chart. Output: analysis/charts/dw_<bot|pool_<id>|<a>_<b>>_1h_<N>m.html
 *
 * Research knobs (--alpha, --gain, --dw, --lb, --clip) intentionally stay on
 * the analyzer itself — call it directly for parameter sweeps:
 *   node dist/analysis/analyze_dynamic_weight.js --file <candles.json> --alpha 0.6
 *
 * Advanced/weight-tuning command — see analysis/README.md and
 * analysis/trend_detection/DYNAMIC_WEIGHT_RESEARCH.md.
 */

import { pathToFileURL } from 'node:url';
import { getErrorMessage } from '../modules/utils/errors.js';
import { run } from './chart_command.js';

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
    run('dw').catch((err: unknown) => {
        console.error(`[dw] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    });
}
