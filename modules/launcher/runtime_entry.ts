import { fileURLToPath } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { path } from '../path_api.js';
import { isDistRuntime as isDistCodeRoot } from '../utils/build_dir.js';

// child_process is resolved lazily so tests (and embedded callers) can stub the
// spawn binding on the CJS module object before the first run.
const require = createRequire(import.meta.url);

// Centralised scripts root: the directory containing the entry-point scripts.
// At this module depth (modules/launcher/), it resolves to <root> (source)
// or <root>/dist (compiled).  All launcher modules should import this rather
// than computing it themselves with fragile __dirname arithmetic.
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..');

function stripKnownExtension(fileName: string) {
    return fileName.replace(/\.(?:[cm]?js|ts)$/i, '');
}

function buildRuntimeScriptPath(codeRoot: string, scriptSegments: string[]) {
    if (!Array.isArray(scriptSegments) || scriptSegments.length === 0) {
        throw new Error('scriptSegments must contain at least one path segment');
    }

    // Runtime is dist-only since the tsx removal: plain node executes the
    // compiled entries, so entrypoints always resolve to .js.
    const scriptExt = '.js';
    const normalizedSegments = [...scriptSegments];
    const lastSegment = normalizedSegments.pop() as string;
    normalizedSegments.push(`${stripKnownExtension(lastSegment)}${scriptExt}`);
    return path.join(codeRoot, ...normalizedSegments);
}

function buildRuntimeScriptArgs({
    codeRoot,
    scriptSegments,
    scriptArgs = [],
}: {
    codeRoot: string;
    scriptSegments: string[];
    scriptArgs?: string[];
}) {
    const scriptPath = buildRuntimeScriptPath(codeRoot, scriptSegments);
    return [scriptPath, ...scriptArgs];
}

/**
 * Run a compiled entry point in a child process with inherited stdio.
 *
 * Every CLI command that delegates to `dist/scripts/**`, `dist/analysis/**`,
 * `dist/unlock.js` or `dist/pm2.js` needs the same four things: an existence
 * check that names the entry, an inherited-stdio spawn, spawn-error propagation
 * and a non-zero policy. Centralising it keeps those commands reporting
 * identically instead of each one re-deriving the boilerplate.
 *
 * @returns the child's exit status (1 when the child died from a signal).
 * @throws when the entry point is missing, cannot be spawned, or exits non-zero
 *         with `nonZero: 'throw'`.
 */
function runRuntimeScript(
    scriptPath: string,
    scriptArgs: string[],
    {
        label,
        cwd,
        nonZero = 'ignore',
    }: {
        /** Command name used in error messages, e.g. 'order' or 'TradingView exporter'. */
        label: string;
        cwd: string;
        /** 'ignore' (default) returns the status so the caller can mirror it. */
        nonZero?: 'ignore' | 'throw';
    },
): number {
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`${label} not found at ${scriptPath} (run npm run build first)`);
    }
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
        cwd,
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    const status = result.status ?? 1;
    if (nonZero === 'throw' && status !== 0) {
        throw new Error(`${label} exited with status ${status}`);
    }
    return status;
}

export { buildRuntimeScriptArgs, buildRuntimeScriptPath, isDistCodeRoot, runRuntimeScript, SCRIPTS_ROOT }

