'use strict';

/**
 * Shared argument walker for the market_adapter CLI entry points.
 *
 * The runners expose an overlapping set of source/window tuning flags that
 * must behave identically everywhere (`--bootstrapHours`, `--sourceRetries`,
 * `--maxPages`, the unsupported `--gridResetFactor` guard, ...). Callers
 * register handlers instead of re-listing the same switch cases; the walker
 * owns value consumption, `--help`/`-h`, and the unknown-flag error.
 *
 * Values are the next argv token, or the text after `=` in a `--flag=value`
 * token. The `=` form exists because a bare value that itself starts with `--`
 * is rejected as a missing value (`--out --weird` fails, `--out=--weird` works).
 *
 * Deliberately free of Node globals: callers pass in their own argv and own
 * the `process.exit` policy via `onHelp`, so this module stays browser-safe.
 */

interface CliArgHandlers {
    /** Flags that take a value; receives the raw next argv token (never missing or flag-shaped). */
    value?: Record<string, (raw: string) => void>;
    /** Flags that take no value. */
    flag?: Record<string, () => void>;
    /** Invoked for `--help` / `-h`; the caller decides whether to exit. */
    onHelp: () => void;
}

export function walkCliArgs(args: readonly string[], handlers: CliArgHandlers): void {
    for (let i = 0; i < args.length; i++) {
        const rawArg = args[i];
        // `--flag=value` keeps a value that itself starts with `--` addressable.
        const eq = rawArg.startsWith('--') ? rawArg.indexOf('=') : -1;
        const inlineValue = eq > 2 ? rawArg.slice(eq + 1) : undefined;
        const a = eq > 2 ? rawArg.slice(0, eq) : rawArg;

        if (a === '--gridResetFactor') {
            throw new Error('--gridResetFactor is no longer supported; use --deltaPercent <percent>');
        }
        if (a === '--help' || a === '-h') {
            if (inlineValue !== undefined) {
                throw new Error(`Flag ${a} does not take a value`);
            }
            handlers.onHelp();
            continue;
        }

        const valueHandler = handlers.value?.[a];
        if (valueHandler) {
            if (inlineValue !== undefined) {
                valueHandler(inlineValue);
                continue;
            }
            const raw = args[i + 1];
            if (raw === undefined || raw.startsWith('--')) {
                throw new Error(`Flag ${a} expects a value; got ${raw === undefined ? 'nothing' : raw}`);
            }
            valueHandler(raw);
            i++;
            continue;
        }
        const flagHandler = handlers.flag?.[a];
        if (flagHandler) {
            if (inlineValue !== undefined) {
                throw new Error(`Flag ${a} does not take a value`);
            }
            flagHandler();
            continue;
        }
        throw new Error(`Unknown argument: ${rawArg}`);
    }
}
