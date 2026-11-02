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
import { CLI_COLORS, colorize } from './cli_colors.js';

/** Erase the current terminal line (progress updates overwrite in place). */
const CLEAR_LINE = '\r\x1b[2K';

/** Console tags for the read-only analysis commands. */
export const CLI_TAGS = {
    assets: '[Assets]',
    liquidity: '[Liquidity]',
    tradingView: '[TradingView]',
    dynamicWeight: '[DynamicWeight]',
    pnl: '[PnL]',
    orders: '[Order]',
    volatility: '[Volatility]',
    regime: '[Regime]',
    regimeWindows: '[RegimeWindows]',
    kalman: '[Kalman]',
    derivatives: '[Derivatives]',
} as const;

/** Width of the report section headers (`── Title ──…`). */
const SECTION_WIDTH = 70;

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
 * The caller supplies the file URL (analysis/chart_utils.toFileUrl); `kind`
 * overrides the lowercased label in the "Open …" half (`'PnL report'` →
 * `'report'`).
 */
export function savedLine(tag: string, label: string, fileUrl: string, kind?: string): string {
    return `\n${tag} ✓ ${label} saved. Open ${kind ?? label.toLowerCase()}: (${fileUrl})`;
}

/** Persistent `[Tag] message` line, e.g. `[Assets] Loading … from chain...`. */
export function loadingLine(tag: string, message: string): string {
    return `${tag} ${message}`;
}

/**
 * Report section header block (leading blank line included):
 * `\n  ── Title ─────────────────────────────…`, bold amber.
 */
export function section(title: string, width = SECTION_WIDTH): string {
    const rule = '─'.repeat(Math.max(0, width - title.length));
    return `\n${colorize(CLI_COLORS.bold + CLI_COLORS.yellow, `  ── ${title} ${rule}`)}`;
}

/** Warning bullets (`  • text`, red), one per entry. */
export function warningLines(warnings: readonly string[]): string[] {
    return warnings.map((text) => colorize(CLI_COLORS.sell, `  • ${text}`));
}

/**
 * A section header plus its warning bullets, or '' when there is nothing to
 * report. Every report command prints warnings the same way through this.
 */
export function warningsBlock(warnings: readonly string[], width = SECTION_WIDTH): string {
    if (warnings.length === 0) return '';
    return [section('Warnings', width), ...warningLines(warnings)].join('\n');
}

/** Muted trailing summary line, printed just above the saved-file link. */
export function summaryLine(text: string): string {
    return colorize(CLI_COLORS.gray, `  ${text}`);
}
