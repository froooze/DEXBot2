#!/usr/bin/env node
'use strict';
/**
 * Usage:
 *   dexbot tv <bot|pool|AssetA/AssetB> [--month N] [--chart <path>] [--feed|--pool|--book]
 *
 * Thin entry for the shared chart-command pipeline in scripts/chart_command.ts
 * (identical fetch/target logic as `dexbot dw`). This command renders through
 * the TradingView exporter (analysis/tradingview/analyze_tradingview.js):
 * 1h candles, N months of history (default 3), bot charts pick up the AMA +
 * order overlay from profiles/orders/<botKey>.json automatically.
 *
 * Target resolution (default: pool-first, orderbook fallback when no pool):
 *   - bot name/key from profiles/bots.json
 *   - pool id (e.g. 133 or 1.19.133, always LP pool candles)
 *   - AssetA/AssetB symbols; MPA pairs (e.g. BTS/HONEST.USD) can opt into
 *     the on-chain price-feed history with --feed.
 */

import { pathToFileURL } from 'node:url';
import { getErrorMessage } from '../modules/utils/errors.js';
import { run } from './chart_command.js';

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
    run('tv').catch((err: unknown) => {
        console.error(`[tv] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    });
}
