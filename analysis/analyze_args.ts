'use strict';

/**
 * Shared command-line parsing for the analysis runners.
 *
 * Every analysis CLI accepts the same base flags (`--source`, `--bot-key`,
 * `--file`, `--list-bots`, `--quiet`) plus its own tool-specific options. The
 * helpers here own the shared base so each `parseArgs` only has to describe the
 * flags it adds.
 */

import type { SourceConfig } from './resolve_source.js';

/** Fields every analysis CLI config shares. */
interface AnalysisBaseConfig {
    source: { type: string; config: SourceConfig };
    quiet: boolean;
    listBots: boolean;
}

/** Fresh base config for the common `--source market_adapter --bot-key <key>` flow. */
export function baseAnalysisConfig(): AnalysisBaseConfig {
    return {
        source: { type: 'market_adapter', config: { botKey: '' } },
        quiet: false,
        listBots: false,
    };
}

/**
 * Consume one of the flags shared by every analysis CLI
 * (`--source`, `--bot-key`, `--file`, `--list-bots`, `--quiet`).
 *
 * @param next  returns the next argv token and advances the caller's index,
 *              e.g. `() => args[++i]`.
 * @returns true when the flag was recognized (and any value consumed), so the
 *          caller can `continue` to the next token.
 */
export function consumeCommonAnalysisArg(
    arg: string,
    next: () => string,
    config: AnalysisBaseConfig,
): boolean {
    switch (arg) {
        case '--source':
            config.source.type = next();
            return true;
        case '--bot-key':
            config.source.config.botKey = next();
            return true;
        case '--file':
            config.source.config.filePath = next();
            config.source.type = 'json';
            return true;
        case '--list-bots':
            config.listBots = true;
            return true;
        case '--quiet':
            config.quiet = true;
            return true;
        default:
            return false;
    }
}

/**
 * Print the standard analysis-CLI help preamble:
 * `title` / blank / `Usage: node dist/analysis/<usagePath> [options]` / blank /
 * `Options:`. Callers then emit their own option rows (see `helpRow`).
 */
export function printHelpHeader(title: string, usagePath: string): void {
    console.log(title);
    console.log('');
    console.log(`Usage: node dist/analysis/${usagePath} [options]`);
    console.log('');
    console.log('Options:');
}

/**
 * Render one aligned option row for a hand-written help body:
 * two-space indent, `flag` padded to `width`, then `description`.
 * `width` is per-tool so adopting this helper keeps the original column.
 */
export function helpRow(flag: string, description: string, width: number): string {
    return `  ${flag.padEnd(width)}${description}`;
}
