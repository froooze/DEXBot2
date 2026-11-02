#!/usr/bin/env node
'use strict';
/**
 * Usage:
 *   dexbot a bts [options]                    # shorthand for `dexbot asset bts`
 *   dexbot a <symbol|1.3.x> [options]         # shorthand for an issued asset
 *   dexbot asset bts [options]
 *   dexbot asset <symbol|1.3.x> [options]
 *
 * Thin router behind the two live-chain supply distribution analyzers:
 *   bts                -> scripts/bts_distribution.js    (core asset 1.3.0)
 *   <symbol|1.3.x>     -> scripts/token_distribution.js  (any issued UIA/MPA)
 *
 * The analyzers own the chain scan, the terminal report and the HTML output;
 * this entry only picks the target script, validates that the forwarded flags
 * belong to it, and keeps the option order untouched. Per-target flag reference
 * stays in the analyzers: `node dist/scripts/bts_distribution.js --help`,
 * `node dist/scripts/token_distribution.js --help`.
 */

import path from 'node:path';
import { dirname as _esmDirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PATHS } from '../modules/paths.js';
import { getErrorMessage } from '../modules/utils/errors.js';
import { runRuntimeScript } from '../modules/launcher/runtime_entry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);

type AssetKind = 'bts' | 'token';

interface AssetConfig {
    /** Distribution analyzer to run, or null when no target was given. */
    kind: AssetKind | null;
    /** Token symbol or asset id (token kind only). */
    asset: string | null;
    /** Flags forwarded verbatim to the analyzer. */
    scriptArgs: string[];
    help: boolean;
}

/** Shared by both analyzers. */
const COMMON_VALUE_FLAGS = ['--node', '--detail', '--vesting-max', '--gap', '--html'];
const COMMON_BOOLEAN_FLAGS = ['--json', '--no-html'];
/** Core-asset (BTS) analyzer only. */
const BTS_VALUE_FLAGS = ['--holders', '--circulating'];
/** Issued-asset (token) analyzer only. */
const TOKEN_VALUE_FLAGS = ['--concurrency'];
const TOKEN_BOOLEAN_FLAGS = ['--no-orders'];

const CORE_SYMBOL = 'BTS';
const CORE_ASSET_ID = '1.3.0';

const ANALYZERS: Record<AssetKind, { script: string; label: string }> = {
    bts: { script: 'bts_distribution.js', label: 'BTS distribution analyzer' },
    token: { script: 'token_distribution.js', label: 'Token distribution analyzer' },
};

const USAGE_SUFFIX = 'Usage: dexbot asset <bts|symbol|1.3.x> [options]';

function printUsage(): void {
    console.log(USAGE_SUFFIX);
    console.log('Live-chain supply distribution: where an asset sits across accounts, collateral,');
    console.log('pools, orders, vesting and governance locks. Read-only (no keys, no transactions).');
    console.log('Shorthand: dexbot a <bts|symbol|1.3.x>.');
    console.log('');
    console.log('  bts                Core-asset supply distribution (BTS, 1.3.0)');
    console.log('  <symbol|1.3.x>     Issued-asset distribution (UIA/MPA) by symbol or object id');
    console.log('');
    console.log('Options (both targets):');
    console.log('  --node URL       Pin a WebSocket node (repeatable; default built-in pool)');
    console.log('  --detail N       Rows in detail tables');
    console.log('  --vesting-max N  Highest 1.13.x object id to probe');
    console.log('  --gap N          Stop id scans after N consecutive missing ids');
    console.log('  --html PATH      Report path');
    console.log('  --no-html        Do not write an HTML report');
    console.log('  --json           Print JSON instead of the terminal report (HTML still written)');
    console.log('  --help           Show this help');
    console.log('');
    console.log('bts only:');
    console.log('  --holders N|all  Liquid holders from asset_api (all = full rich list)');
    console.log('  --circulating N  Reference circulating supply to compare the derived float');
    console.log('');
    console.log('Issued asset only:');
    console.log('  --no-orders      Skip the per-asset limit-order scan (~20s on mainnet)');
    console.log('  --concurrency N  Concurrent get_limit_orders calls');
    console.log('');
    console.log('Output: analysis/charts/bts-distribution.html, analysis/charts/token-<SYMBOL>-distribution.html');
    console.log('Full flag docs: node dist/scripts/bts_distribution.js --help');
    console.log('                node dist/scripts/token_distribution.js --help');
}

/**
 * Split `<target> <flags...>` into the analyzer identity plus the untouched
 * flag list. `bts` (and the core asset id) route to the core-asset analyzer;
 * anything else is an issued-asset symbol/id. Flags are validated per target so
 * a `bts`-only option cannot be silently accepted (and ignored) by the token
 * analyzer, or vice versa.
 */
function parseArgs(argv: string[]): AssetConfig {
    if (argv.some((arg) => arg === '--help' || arg === '-h')) {
        return { kind: null, asset: null, scriptArgs: [], help: true };
    }

    const [first, ...args] = argv;
    if (first === undefined) return { kind: null, asset: null, scriptArgs: [], help: false };
    if (first.startsWith('-')) {
        throw new Error(`Expected a target (bts or an asset symbol/id). ${USAGE_SUFFIX}`);
    }

    const isCore = first.toLowerCase() === CORE_SYMBOL.toLowerCase() || first === CORE_ASSET_ID;
    const kind: AssetKind = isCore ? 'bts' : 'token';
    const asset: string | null = isCore ? null : first;

    // `token` is not a word in this grammar — a target is either `bts` or the
    // symbol itself. Catch the near-miss instead of looking up a symbol called
    // "token" and reporting it as unknown.
    if (asset !== null && asset.toLowerCase() === 'token' && args.length > 0 && !args[0].startsWith('-')) {
        throw new Error('`token` is not a subcommand: pass the symbol directly (dexbot asset <symbol|1.3.x>).');
    }

    const valueFlags = new Set([...COMMON_VALUE_FLAGS, ...(kind === 'bts' ? BTS_VALUE_FLAGS : TOKEN_VALUE_FLAGS)]);
    const booleanFlags = new Set([...COMMON_BOOLEAN_FLAGS, ...(kind === 'token' ? TOKEN_BOOLEAN_FLAGS : [])]);
    const scriptArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-h' || arg === '--help') continue;
        const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
        if (eq > 0) {
            const flag = arg.slice(0, eq);
            if (!valueFlags.has(flag)) throw new Error(`${unknownFlagMessage(flag, kind)} ${USAGE_SUFFIX}`);
            scriptArgs.push(arg);
            continue;
        }
        if (booleanFlags.has(arg)) {
            scriptArgs.push(arg);
            continue;
        }
        if (valueFlags.has(arg)) {
            const value = args[++i];
            if (value === undefined) throw new Error(`Missing value for ${arg}`);
            scriptArgs.push(arg, value);
            continue;
        }
        throw new Error(`${unknownFlagMessage(arg, kind)} ${USAGE_SUFFIX}`);
    }

    return { kind, asset, scriptArgs, help: false };
}

function unknownFlagMessage(flag: string, kind: AssetKind): string {
    if (!flag.startsWith('-')) return `Unexpected argument "${flag}".`;
    if (kind === 'bts' && (TOKEN_VALUE_FLAGS.includes(flag) || TOKEN_BOOLEAN_FLAGS.includes(flag))) {
        return `${flag} applies to issued assets only; the core asset uses --holders and --circulating.`;
    }
    return `Unknown flag "${flag}".`;
}

/** Spawn the analyzer with inherited stdio and mirror its exit status. */
function runAnalyzer(kind: AssetKind, scriptArgs: string[], asset: string | null): void {
    const { script, label } = ANALYZERS[kind];
    const args = asset ? [asset, ...scriptArgs] : scriptArgs;
    process.exitCode = runRuntimeScript(path.join(__dirname, script), args, {
        label,
        cwd: PATHS.PROJECT_ROOT,
    });
}

async function run(): Promise<void> {
    const config = parseArgs(process.argv.slice(2));
    if (config.help || !config.kind) {
        printUsage();
        if (!config.help) process.exitCode = 1;
        return;
    }
    runAnalyzer(config.kind, config.scriptArgs, config.asset);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
    run().catch((err: unknown) => {
        console.error(`[Assets] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    });
}

export { parseArgs, ANALYZERS, CORE_ASSET_ID };
