'use strict';

/**
 * Spawn an analysis entry point (compiled `dist/analysis/**\/*.js`).
 *
 * Chart-style commands (`tv`, `dw`, `liquid`) all render through a separate
 * analysis binary. This helper centralises the path resolution, existence
 * check, project-root cwd, and exit-status handling so a missing build or a
 * crashed renderer reports the same way everywhere.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { PATHS } from '../modules/paths.js';
import { runRuntimeScript } from '../modules/launcher/runtime_entry.js';

/** Absolute path to an analysis script, e.g. ['tradingview','analyze_tradingview.js']. */
function analysisScriptPath(segments: string[]): string {
    return path.join(__dirname, '..', 'analysis', ...segments);
}

/**
 * Resolve, run and validate an analysis script.
 * Throws with a command-specific `label` when the build is missing or the
 * renderer exits non-zero; child stdio is inherited.
 */
function runAnalysisScript(segments: string[], args: string[], label: string): void {
    runRuntimeScript(analysisScriptPath(segments), args, {
        label,
        cwd: PATHS.PROJECT_ROOT,
        nonZero: 'throw',
    });
}

export { analysisScriptPath, runAnalysisScript };
