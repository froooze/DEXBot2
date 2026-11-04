/**
 * modules/outcome.ts - Three-valued outcomes
 *
 * The engine has many operations whose result is genuinely unknowable: a
 * broadcast whose receipt was lost, a chain read that came back ambiguous, a
 * timeout that won a race. Historically each such site returned a plain object
 * with an ad-hoc `uncertain: true` field — sometimes next to a *second* ad-hoc
 * flag describing the same fact (`ambiguousRead`), so the two could disagree
 * and no consumer was forced to handle the third case at all.
 *
 * `Outcome<T>` (modules/types.ts) gives that third case a name. This module is
 * the only place those result objects are constructed, so the flags cannot
 * drift apart: one `cause` in, both legacy booleans derived out.
 *
 * Browser-safe: no Node APIs.
 */

import type { UnknownCause, UnknownOutcome } from './types.js';

/**
 * Build an `unknown` outcome. Callers must name the cause.
 *
 * @param cause - Why the outcome is unknown
 * @param detail - Optional human-readable context
 * @returns {UnknownOutcome} An `unknown` outcome
 */
export function unknownOutcome(cause: UnknownCause, detail?: string): UnknownOutcome {
    return detail ? { kind: 'unknown', cause, detail } : { kind: 'unknown', cause };
}

// ===============================================================================
// COW batch results
// ===============================================================================
//
// The COW pipeline returns a looser shape for historical reasons
// (`executed` / `hadRotation` / `uncertain` / `ambiguousRead`). It must keep
// those fields — the maintenance runtime and tests read them — but it must not
// keep *deciding* them independently. Every unknown-batch return goes through
// `unknownCowOutcome`, which derives the legacy booleans from `cause` so they
// are consistent by construction.

export interface CowOutcomeShape {
    executed: boolean;
    hadRotation: boolean;
    [key: string]: unknown;
}

export interface UnknownCowOutcome extends CowOutcomeShape {
    /** Canonical discriminator. */
    kind: 'unknown';
    /** Canonical reason. */
    cause: UnknownCause;
    /** Legacy alias kept for existing readers; always true. */
    uncertain: true;
    /** Legacy alias kept for existing readers; derived from `cause`. */
    ambiguousRead: boolean;
}

/**
 * Build a COW result for a batch whose effect is not knowable.
 *
 * `cause` is the single input: `uncertain` is always true and `ambiguousRead`
 * is true exactly when the cause is an ambiguous read. A caller cannot make
 * those two disagree because it never sets them. Fields in `extra` are merged
 * FIRST, so they cannot override the canonical ones either.
 *
 * @param cause - Why the outcome is unknown
 * @param extra - Additional fields to merge (e.g. adoptedCount)
 * @returns {UnknownCowOutcome} Consistent COW result
 */
export function unknownCowOutcome(cause: UnknownCause, extra: Record<string, unknown> = {}): UnknownCowOutcome {
    const outcome = unknownOutcome(cause);
    return {
        ...extra,
        executed: false,
        hadRotation: false,
        kind: outcome.kind,
        cause: outcome.cause,
        uncertain: true,
        ambiguousRead: outcome.cause === 'ambiguous-read',
    };
}
