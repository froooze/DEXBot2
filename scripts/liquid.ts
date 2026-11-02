#!/usr/bin/env node
'use strict';
/**
 * Usage:
 *   dexbot liquid <bot|AssetA/AssetB> [--range F] [--depth N] [--steps N]
 *                 [--pool 1.19.x] [--chart <path>] [--json <path>] [--quiet]
 *
 * Thin CLI wrapper behind the liquidity depth chart generator
 * (analysis/analyze_liquidity.js): resolve a bot name/key or a pair target to
 * its base/quote symbols, then render the live order-book + AMM pool chart.
 *
 * Supported targets:
 *   - bot name or key from profiles/bots.json (uses the bot's assetA/assetB)
 *   - AssetA/AssetB symbols (case-insensitive; normalized to UPPERCASE)
 *
 * The analyzer owns the chain work, depth sampling and HTML rendering; this
 * entry only resolves the target and forwards the liquidity options.
 */

import { pathToFileURL } from 'node:url';
import { getErrorMessage } from '../modules/utils/errors.js';
import { splitPairTarget, normalizeAssetSymbol } from '../modules/utils/asset_symbols.js';
import { findBotByTarget, knownTargetsHint } from './chart_targets.js';
import { runAnalysisScript } from './analysis_runner.js';

interface LiquidConfig {
    target: string | null;
    analyzerArgs: string[];
    help: boolean;
}

interface ResolvedPair {
    base: string;
    quote: string;
    botName?: string;
    botKey?: string;
}

const PASS_THROUGH_FLAGS = new Set(['--range', '--depth', '--steps', '--pool', '--chart', '--json']);

function printUsage(): void {
    console.log('Usage: dexbot liquid <bot|AssetA/AssetB> [options]');
    console.log('Live cumulative-depth chart blending the limit-order book and the AMM pool (uPlot).');
    console.log('');
    console.log('  <bot>          Bot name or key from profiles/bots.json');
    console.log('  AssetA/AssetB  Pair symbols, e.g. TOKENA/TOKENB (case-insensitive)');
    console.log('');
    console.log('Options:');
    console.log('  --range <f>      Price window half-width (default 0.5 => +/-50%)');
    console.log('  --depth <n>      Order-book levels per side (default 300; node cap commonly 300)');
    console.log('  --steps <n>      Price samples across the window (default 400)');
    console.log('  --pool <1.19.x>  Restrict to a specific pool (default: deepest pool)');
    console.log('  --chart <path>   Override the output HTML path');
    console.log('  --json <path>    Optional JSON dump of the sampled depth series');
    console.log('  --quiet          Suppress the console summary');
    console.log('  --help           Show this help');
    console.log('');
    console.log('Output: analysis/charts/liquidity_<base>_<quote>.html');
    console.log('Price is quote per base; click the x-axis to invert, y-axis to switch depth asset.');
}

function parseArgs(argv: string[]): LiquidConfig {
    let target: string | null = null;
    let help = false;
    const analyzerArgs: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            help = true;
        } else if (arg === '--quiet') {
            analyzerArgs.push(arg);
        } else if (PASS_THROUGH_FLAGS.has(arg)) {
            const value = argv[++i];
            if (value == null || value.startsWith('--')) {
                throw new Error(`${arg} expects a value. Usage: dexbot liquid <bot|AssetA/AssetB> [options]`);
            }
            analyzerArgs.push(arg, value);
        } else if (arg.startsWith('--')) {
            throw new Error(`Unknown flag "${arg}". Usage: dexbot liquid <bot|AssetA/AssetB> [options]`);
        } else if (!target) {
            target = arg;
        } else {
            throw new Error(`Unexpected argument "${arg}". Only one target is supported. Usage: dexbot liquid <bot|AssetA/AssetB> [options]`);
        }
    }
    return { target, analyzerArgs, help };
}

function resolveTarget(target: string): ResolvedPair {
    if (target.includes('/')) {
        const parts = splitPairTarget(target);
        if (parts.length !== 2) {
            throw new Error(`Invalid pair "${target}". Use AssetA/AssetB, e.g. TOKENA/TOKENB`);
        }
        return { base: parts[0], quote: parts[1] };
    }

    const hit = findBotByTarget(target);
    if (!hit) throw new Error(`Unknown target "${target}". ${knownTargetsHint(false)}`);
    const base = normalizeAssetSymbol(hit.meta.assetA);
    const quote = normalizeAssetSymbol(hit.meta.assetB);
    if (!base || !quote) throw new Error(`Bot '${target}' has no assetA/assetB pair in profiles/bots.json`);
    return { base, quote, botName: hit.meta.name, botKey: hit.botKey };
}

async function run(): Promise<void> {
    const { target, analyzerArgs, help } = parseArgs(process.argv.slice(2));
    if (help || !target) {
        printUsage();
        if (!help && !target) process.exitCode = 1;
        return;
    }

    const pair = resolveTarget(target);
    runAnalysisScript(
        ['analyze_liquidity.js'],
        ['--pair', `${pair.base}/${pair.quote}`, ...analyzerArgs],
        'Liquidity chart generator',
    );
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
    run().catch((err: unknown) => {
        console.error(`[liquid] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    });
}

export { parseArgs, resolveTarget, printUsage, run };
