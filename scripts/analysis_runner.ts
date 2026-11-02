'use strict';

/**
 * Spawn an analysis entry point (compiled `dist/analysis/**\/*.js`).
 *
 * Chart-style commands (`tv`, `dw`, `liquid`) all render through a separate
 * analysis binary. This helper centralises the path resolution, existence
 * check, project-root cwd, and exit-status handling so a missing build or a
 * crashed renderer reports the same way everywhere.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { PATHS } from '../modules/paths.js';

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
    const script = analysisScriptPath(segments);
    if (!fs.existsSync(script)) {
        throw new Error(`${label} not found at ${script} (run npm run build first)`);
    }
    const result = spawnSync(process.execPath, [script, ...args], {
        cwd: PATHS.PROJECT_ROOT,
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label} exited with status ${result.status}`);
}

export { analysisScriptPath, runAnalysisScript };
