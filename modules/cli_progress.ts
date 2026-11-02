'use strict';

/**
 * modules/cli_progress.ts - Shared terminal status style for CLI commands.
 *
 * One place for the `[Tag] …` line style used by the analysis commands
 * (`dexbot liq`, the chart exporters, the supply distribution analyzers):
 *
 *   [Tag] Loading …            caller's console.log (persistent)
 *   [Tag] scanning 1.13.x …    progressLine() - transient, stderr, TTY only
 *   [Tag] ✓ Report saved …     savedLine() (persistent, clickable file:// link)
 *
 * Keeping the tag, the clear-line escape and the trailer wording here is what
 * keeps `dexbot liq`, `dexbot tv`, `dexbot asset` … visually identical instead
 * of each script re-implementing the same three things.
 *
 * Browser-safe: no Node imports. The stderr access is guarded through
 * modules/env.ts, so the module can be imported from browser-reachable code
 * without touching `process`.
 */

import { hasProcess } from './env.js';

/** Erase the current terminal line (progress updates overwrite in place). */
const CLEAR_LINE = '\r\x1b[2K';

/** Console tags for the read-only analysis commands. */
export const CLI_TAGS = {
    assets: '[Assets]',
    liquidity: '[Liquidity]',
    tradingView: '[TradingView]',
    dynamicWeight: '[DynamicWeight]',
    pnl: '[PnL]',
} as const;

interface WriteStreamLike {
    write(chunk: string): unknown;
    isTTY?: boolean;
}

/** stderr when it is an interactive terminal, otherwise null (no-op logging). */
function progressStream(): WriteStreamLike | null {
    if (!hasProcess()) return null;
    const stream = (globalThis as unknown as { process?: { stderr?: WriteStreamLike } }).process?.stderr;
    return stream && stream.isTTY ? stream : null;
}

/**
 * Write (or overwrite) a transient `[Tag] message` progress line.
 * Silenced when `enabled` is false, when stderr is not a TTY, or in a browser.
 */
export function progressLine(tag: string, enabled: boolean, message: string): void {
    if (!enabled) return;
    const stream = progressStream();
    if (!stream) return;
    stream.write(`${CLEAR_LINE}${tag} ${message}`);
}

/** Erase the transient progress line before the report is printed. */
export function clearProgressLine(enabled = true): void {
    if (!enabled) return;
    const stream = progressStream();
    if (stream) stream.write(CLEAR_LINE);
}

/**
 * Bind {@link progressLine} to one tag, so a script keeps its short
 * `progress(enabled, message)` call sites while the format stays centralized.
 */
export function taggedProgress(tag: string): (enabled: boolean, message: string) => void {
    return (enabled: boolean, message: string): void => progressLine(tag, enabled, message);
}

/**
 * Trailer printed after a report is written, e.g.
 * `[Assets] ✓ Report saved. Open report: (file:///…/bts-distribution.html)`.
 * The caller supplies the file URL (analysis/chart_utils.toFileUrl).
 */
export function savedLine(tag: string, label: string, fileUrl: string): string {
    const kind = label.toLowerCase();
    return `\n${tag} ✓ ${label} saved. Open ${kind}: (${fileUrl})`;
}
