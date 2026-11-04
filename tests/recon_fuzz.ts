/**
 * tests/recon_fuzz.ts
 *
 * Deterministic interleaving fuzzer for the reconciliation engine.
 *
 * WHY THIS EXISTS
 * ---------------
 * The order engine's failure modes are interleavings: a fill that lands before
 * the snapshot that would have matched it, a read that lags behind a confirmed
 * broadcast, a truncated snapshot that looks exactly like "the account is
 * empty". Example-based tests cannot enumerate those. This harness drives the
 * REAL `SyncEngine` against a scripted chain, asserts the engine's invariants
 * after every single event, and shrinks a failing sequence to a minimal
 * reproduction (seed + step list).
 *
 * WHAT IT ASSERTS
 * ---------------
 *   I1  no two slots own the same chain order id        (INV-ID)
 *   I2  no two placed slots share a (type, price) level (INV-GRID, one per level)
 *   I3  every placed slot is known to the lifecycle registry
 *   I4  a slot's registry record agrees with the slot's chain id
 *   I5  no slot is in an illegal state combination
 *   I6  fund totals stay finite and non-negative
 *   I7  the engine never throws while reconciling
 *
 * WHAT IT DOES NOT ASSERT
 * -----------------------
 * Policy. The engine deliberately defers single-cycle cleanups (fresh placement
 * grace, in-flight guards); asserting "eventually clean after exactly N
 * cycles" would encode one policy and reject correct alternatives. The
 * invariants above are policy-free: they must hold after every event.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { createSilentLogger } = require('./helpers/silent_logger');
const { makeTestGenesis } = require('./helpers/order_test_helpers');
const { assertOrdersStructurallySound } = require('./helpers/order_test_helpers');

require('../modules/order/utils/math')._setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.1 },
        limitOrderUpdate: { bts: 0.001 },
        limitOrderCancel: { bts: 0 },
        makerFeeDiscountPercent: 0.9,
    },
    TEST: { chargesMarketFees: false },
});

// ===============================================================================
// Deterministic randomness
// ===============================================================================

/** mulberry32 — small, fast, seedable. Same seed => same run, forever. */
function makeRng(seed: number) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
        pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)],
        chance: (p: number) => next() < p,
    };
}

// ===============================================================================
// Chain encoding
// ===============================================================================
//
// The chain orders are built from the *prices the engine itself uses*, so the
// fuzzer cannot manufacture phantom mismatches through float rounding. The
// assets mirror the test manager: A = TEST (precision 8), B = BTS (precision 5),
// so precisionDelta = 3 and price = (quote/base) * 1e3 for a SELL.

const ASSET_A = { symbol: 'TEST', id: '1.3.0', precision: 8 };
const ASSET_B = { symbol: 'BTS', id: '1.3.1', precision: 5 };
const PRECISION_FACTOR = Math.pow(10, ASSET_A.precision - ASSET_B.precision); // 1e3

/** Encode (type, price, size) as a Bitshare-ish chain order object. */
function encodeChainOrder(id: string, type: string, price: number, size: number, filled = 0) {
    const remaining = Math.max(0, size - filled);
    if (type === ORDER_TYPES.SELL) {
        // base = A, quote = B. price = (quote/base) * F
        const baseAmount = Math.round(remaining * Math.pow(10, ASSET_A.precision));
        const quoteAmount = Math.round((baseAmount * price) / PRECISION_FACTOR);
        return {
            id,
            sell_price: {
                base: { asset_id: ASSET_A.id, amount: String(baseAmount) },
                quote: { asset_id: ASSET_B.id, amount: String(quoteAmount) },
            },
            for_sale: String(baseAmount),
        };
    }
    // base = B, quote = A. price = (base/quote) * F
    const baseAmount = Math.round(remaining * Math.pow(10, ASSET_B.precision));
    const quoteAmount = Math.round((baseAmount * PRECISION_FACTOR) / price);
    return {
        id,
        sell_price: {
            base: { asset_id: ASSET_B.id, amount: String(baseAmount) },
            quote: { asset_id: ASSET_A.id, amount: String(quoteAmount) },
        },
        for_sale: String(baseAmount),
    };
}

// ===============================================================================
// Invariants
// ===============================================================================

function checkInvariants(manager: any, chainIds: Set<string>, snapshot: any[], syncResult: any, context: string): string[] {
    const violations: string[] = [];

    // I5 — structural soundness.
    try {
        assertOrdersStructurallySound(manager);
    } catch (err: any) {
        violations.push(`I5 structural: ${err.message}`);
    }

    const seenOrderIds = new Map<string, string>();
    const seenLevels = new Map<string, string>();

    for (const [slotId, order] of manager.orders as Map<string, any>) {
        if (!order) { violations.push(`I5 ${slotId}: null slot`); continue; }

        const state = order.state;
        const placed = state === ORDER_STATES.ACTIVE || state === ORDER_STATES.PARTIAL;

        if (!placed) {
            if (state !== ORDER_STATES.VIRTUAL) {
                violations.push(`I5 ${slotId}: illegal state ${String(state)}`);
            }
            continue;
        }

        const orderId = order.orderId == null ? '' : String(order.orderId);
        if (!orderId) continue; // a placed slot without an id is a policy deferral, not an invariant break

        // I1 — one slot per chain order id.
        const owner = seenOrderIds.get(orderId);
        if (owner) violations.push(`I1 ${orderId} owned by both ${owner} and ${slotId}`);
        seenOrderIds.set(orderId, slotId);

        // I2 — one order per (type, price) level.
        const levelKey = `${String(order.type)}@${Number(order.price).toFixed(8)}`;
        const levelOwner = seenLevels.get(levelKey);
        if (levelOwner) violations.push(`I2 duplicate level ${levelKey}: ${levelOwner} and ${slotId}`);
        seenLevels.set(levelKey, slotId);

        // I3/I4 — the registry must know the slot and agree on its chain id.
        const view = manager.getLifecycle(orderId);
        if (!view) {
            violations.push(`I3 ${slotId}: no lifecycle view for ${orderId}`);
        } else {
            if (view.orderId !== orderId) {
                violations.push(`I4 ${slotId}: registry says orderId=${String(view.orderId)}, slot says ${orderId}`);
            }
            if (view.slotId && view.slotId !== String(slotId)) {
                violations.push(`I4 ${slotId}: registry says slotId=${view.slotId} for ${orderId}`);
            }
            if (view.isConfirmedGone) {
                violations.push(`I4 ${slotId}: ${orderId} is placed but the registry says 'gone'`);
                void chainIds;
            }
        }
    }

    // I6 — funds must stay finite and non-negative. The ledger is nested:
    // `available.{buy,sell}` is the free capital, `total.grid.*` the committed
    // virtual capital. A NaN in either is the signature of a bookkeeping
    // double-apply or a missing side.
    const funds = manager.funds;
    if (funds && typeof funds === 'object') {
        const probes: Array<[string, unknown]> = [
            ['available.buy', (funds as any)?.available?.buy],
            ['available.sell', (funds as any)?.available?.sell],
            ['total.grid.buy', (funds as any)?.total?.grid?.buy],
            ['total.grid.sell', (funds as any)?.total?.grid?.sell],
            ['virtual.buy', (funds as any)?.virtual?.buy],
            ['virtual.sell', (funds as any)?.virtual?.sell],
        ];
        for (const [key, raw] of probes) {
            if (raw === undefined || raw === null) {
                violations.push(`I6 funds.${key} is missing`);
                continue;
            }
            const value = Number(raw);
            if (Number.isNaN(value)) violations.push(`I6 funds.${key} is NaN`);
            else if (value < -1e-9) violations.push(`I6 funds.${key} went negative (${value})`);
        }
    }

    // I8 — every parseable chain order is accounted for.
    //
    // The chain is the source of truth: an order resting there must either be
    // tracked by a slot (adopted or matched) or be explicitly queued for
    // cancellation / reported as unmatched. An order that is silently ignored
    // is the "lost receipt" class of bug: it sits on the book, burns an
    // unfunded level, and the bot re-CREATEs on top of it.
    const covered = new Set<string>();
    for (const slot of manager.orders.values() as IterableIterator<any>) {
        if (slot && slot.orderId) covered.add(String(slot.orderId));
    }
    for (const entry of syncResult?.unmatchedChainOrders ?? []) {
        const id = entry?.chainOrderId ?? entry?.orderId ?? entry?.id;
        if (id) covered.add(String(id));
    }
    for (const entry of syncResult?.ordersNeedingCorrection ?? []) {
        const id = entry?.chainOrderId ?? entry?.orderId;
        if (id) covered.add(String(id));
    }
    for (const raw of snapshot) {
        if (!raw || !raw.sell_price) continue; // unparseable by construction
        const id = String(raw.id);
        if (!covered.has(id)) {
            violations.push(`I8 chain order ${id} is unaccounted for (not tracked, not unmatched, not queued for cancel)`);
        }
    }

    return violations.map((v) => `[${context}] ${v}`);
}

// ===============================================================================
// Simulator
// ===============================================================================

interface ScenarioStats {
    adopted: number;
    virtualized: number;
    resized: number;
    reads: number;
    unmatched: number;
    reasons: Record<string, number>;
}

interface ChainOrderState {
    id: string;
    type: string;
    price: number;
    size: number;
    filled: number;
}

const OPS = [
    'land',        // a broadcast the engine believes it made becomes visible
    'vanish',      // a broadcast silently failed: engine thinks placed, chain has nothing
    'partialFill', // a resting order loses part of its size
    'fullFill',    // a resting order is consumed
    'orphan',      // a chain order appears at a level the engine does not own
    'lagRead',     // the read is missing the most recent placements
    'malformed',   // the read contains an unparseable entry (unknown, not absent)
    'duplicate',   // a lost-receipt CREATE is re-sent: two chain orders, one level
    'stray',       // a chain order at a level that cannot be adopted (size/type mismatch)
    'idle',        // a plain caught-up read
];

class ChainSim {
    readonly orders = new Map<string, ChainOrderState>();
    private nextId = 1;

    id(): string { return `1.7.${this.nextId++}`; }

    snapshot(models: string[]): any[] {
        const out: any[] = [];
        for (const order of this.orders.values()) {
            if (models.includes('malformed') && order.id.endsWith('7')) {
                // Deliberately unparseable: no sell_price at all. This is the
                // "unknown read" shape — the engine must not treat it as absent.
                out.push({ id: order.id, for_sale: String(order.size) });
                continue;
            }
            out.push(encodeChainOrder(order.id, order.type, order.price, order.size, order.filled));
        }
        return out;
    }
}

async function makeManager() {
    const manager: any = new OrderManager({ market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS' });
    manager.logger = createSilentLogger();
    manager.assets = { assetA: ASSET_A, assetB: ASSET_B };
    const genesis = makeTestGenesis({ startPrice: 100, incrementPercent: 1, count: 11, gapSlots: 0 });
    manager._genesis = genesis;
    manager._gapSlots = 0;
    // Adoption is gated on a known boundary: without one, pass-2 defers every
    // orphan as 'boundary-unknown-deferred' and the scenario never exercises
    // reconciliation at all.
    manager.boundaryIdx = 5;
    await manager.setAccountTotals({ buy: 1e6, sell: 1e6, buyFree: 1e6, sellFree: 1e6 });

    // Seed a small resting grid at genesis levels.
    for (let idx = 2; idx <= 8; idx += 1) {
        const price = genesis.levelAt(idx);
        const type = idx < 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        await manager._updateOrder({
            id: `slot-${idx}`,
            type,
            state: ORDER_STATES.VIRTUAL,
            price,
            size: 10,
            orderId: '',
        });
    }
    return { manager, genesis };
}

/**
 * Run one seeded scenario.
 * @returns {{ violations: string[]; steps: string[]; stats: ScenarioStats }}
 */
async function runScenario(seed: number, stepCount: number): Promise<{ violations: string[]; steps: string[]; stats: ScenarioStats }> {
    const rng = makeRng(seed);
    const { manager, genesis } = await makeManager();
    void genesis;
    const chain = new ChainSim();
    const steps: string[] = [];
    const violations: string[] = [];
    const chainIds = new Set<string>();
    const stats: ScenarioStats = { adopted: 0, virtualized: 0, resized: 0, reads: 0, unmatched: 0, reasons: {} };

    const slots = () => [...manager.orders.values()] as any[];
    const stateOf = () => {
        const map = new Map<string, number>();
        for (const slot of slots()) {
            map.set(String(slot.id), Number(slot.size));
        }
        return map;
    };
    const placedSlots = () => slots().filter((o) => (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL) && o.orderId);
    // A chain order is always BUY or SELL: SPREAD is a local placeholder type
    // that can never rest on the book, and a zero-size order cannot exist. The
    // simulator must not manufacture inputs the chain cannot produce.
    const freeSlots = () => slots().filter(
        (o) => o.state === ORDER_STATES.VIRTUAL
            && !o.orderId
            && (o.type === ORDER_TYPES.BUY || o.type === ORDER_TYPES.SELL)
            && Number(o.size) > 0
    );

    for (let step = 0; step < stepCount; step += 1) {
        const op = rng.pick(OPS);
        steps.push(op);
        const readModels: string[] = [];
        const before = stateOf();
        let snapshot: any[] = [];
        let result: any = null;

        try {
            switch (op) {
                case 'land': {
                    // Every slot the engine believes it placed but the chain has
                    // not shown yet lands now (broadcast success).
                    for (const slot of placedSlots()) {
                        const id = String(slot.orderId);
                        if (chain.orders.has(id)) continue;
                        chain.orders.set(id, { id, type: slot.type, price: slot.price, size: slot.size, filled: 0 });
                    }
                    break;
                }
                case 'vanish': {
                    // A broadcast the engine recorded silently failed: remove the
                    // chain order, leave the engine's belief untouched.
                    const placed = placedSlots();
                    if (placed.length === 0) break;
                    const victim = rng.pick(placed);
                    chain.orders.delete(String(victim.orderId));
                    break;
                }
                case 'partialFill': {
                    const resting = [...chain.orders.values()].filter((o) => o.filled === 0);
                    if (resting.length === 0) break;
                    const victim = rng.pick(resting);
                    victim.filled = victim.size * (0.25 + rng.next() * 0.5);
                    break;
                }
                case 'fullFill': {
                    const resting = [...chain.orders.values()].filter((o) => o.filled < o.size);
                    if (resting.length === 0) break;
                    const victim = rng.pick(resting);
                    chain.orders.delete(victim.id);
                    break;
                }
                case 'orphan': {
                    const free = freeSlots();
                    if (free.length === 0) break;
                    const slot = rng.pick(free);
                    const id = chain.id();
                    chain.orders.set(id, { id, type: slot.type, price: slot.price, size: slot.size, filled: 0 });
                    break;
                }
                case 'duplicate': {
                    // The lost-receipt case: the chain holds a second order at a
                    // level a slot already owns (a CREATE was re-sent because the
                    // first receipt was never seen). Only one may be tracked; the
                    // other must be reported, never silently ignored.
                    const resting = [...chain.orders.values()];
                    if (resting.length === 0) break;
                    const source = rng.pick(resting);
                    const id = chain.id();
                    chain.orders.set(id, { id, type: source.type, price: source.price, size: source.size, filled: 0 });
                    break;
                }
                case 'stray': {
                    // Un-adoptable by construction: right level, wrong size. The
                    // engine can only report it (and queue a cancel) — it must
                    // never lose track of it.
                    const free = freeSlots();
                    if (free.length === 0) break;
                    const slot = rng.pick(free);
                    const id = chain.id();
                    chain.orders.set(id, { id, type: slot.type, price: slot.price, size: Number(slot.size) * 7 + 3, filled: 0 });
                    break;
                }
                case 'lagRead': {
                    readModels.push('lag');
                    break;
                }
                case 'malformed': {
                    readModels.push('malformed');
                    break;
                }
                default:
                    break;
            }

            // Build the snapshot. `lagRead` drops the newest chain order, which
            // is exactly the "read behind a confirmed broadcast" interleaving.
            snapshot = chain.snapshot(readModels);
            if (readModels.includes('lag') && snapshot.length > 0) {
                snapshot = snapshot.slice(0, Math.max(0, snapshot.length - 1));
            }
            chainIds.clear();
            for (const order of snapshot) chainIds.add(String(order.id));

            result = await manager.sync.syncFromOpenOrders(snapshot, { skipAccounting: false });
            stats.reads += 1;
            const unmatchedList = Array.isArray(result?.unmatchedChainOrders) ? result.unmatchedChainOrders : [];
            if (unmatchedList.length > 0) stats.unmatched += 1;
            for (const entry of unmatchedList) {
                const reason = String(entry?.reason ?? 'unspecified');
                stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
            }
        } catch (err: any) {
            violations.push(`[step ${step} ${op}] I7 threw: ${err && err.message ? err.message : String(err)}`);
            break;
        }

        // Coverage counters: prove the scenario actually moved orders around,
        // so a green run is not a vacuous run.
        for (const slot of slots()) {
            const key = String(slot.id);
            const was = before.get(key) ?? 0;
            const now = Number(slot.size);
            if (!slot.orderId) continue;
            if (chainIds.has(String(slot.orderId))) stats.adopted += 1;
            else stats.virtualized += 1;
            if (Math.abs(now - was) > 1e-9) stats.resized += 1;
        }

        const found = checkInvariants(manager, chainIds, snapshot, result, `step ${step} ${op}`);
        if (found.length > 0) {
            if (process.env.RECON_FUZZ_DEBUG === '1') {
                console.error('   --- debug dump ---');
                console.error(`   snapshot ids: ${snapshot.map((o: any) => o.id).join(', ')}`);
                console.error(`   chain belief: ${[...chain.orders.values()].map((o) => `${o.id}:${o.type}@${o.price}x${o.size}/f${o.filled}`).join(', ')}`);
                for (const slot of slots()) {
                    console.error(`   slot ${slot.id} ${slot.type} ${slot.state} price=${slot.price} size=${slot.size} orderId=${slot.orderId}`);
                }
                console.error(`   unmatched: ${JSON.stringify((result?.unmatchedChainOrders ?? []).map((u: any) => `${u.chainOrderId}:${u.reason}`))}`);
                console.error(`   corrections: ${JSON.stringify((result?.ordersNeedingCorrection ?? []).map((u: any) => `${u.chainOrderId}`))}`);
            }
            violations.push(...found);
            // Keep the failing prefix; it is the reproduction.
            break;
        }
    }

    return { violations, steps, stats };
}

// ===============================================================================
// Shrinking
// ===============================================================================

/**
 * Greedily shrink a failing scenario by re-running it at shorter lengths.
 * Deterministic because every run is driven by the same seed.
 */
async function shrink(seed: number, steps: number): Promise<{ steps: number; violations: string[] }> {
    let best = steps;
    let violations: string[] = [];
    let length = steps;
    while (length > 1) {
        const candidate = Math.max(1, Math.floor(length / 2));
        const result = await runScenario(seed, candidate);
        if (result.violations.length > 0) {
            best = candidate;
            violations = result.violations;
            length = candidate;
        } else {
            length = candidate - 1 > 0 && candidate - 1 < length ? candidate - 1 : -1;
            if (length <= 0) break;
            const retry = await runScenario(seed, length);
            if (retry.violations.length > 0) {
                best = length;
                violations = retry.violations;
            } else {
                break;
            }
        }
    }
    if (violations.length === 0) {
        const final = await runScenario(seed, best);
        violations = final.violations;
    }
    return { steps: best, violations };
}

// ===============================================================================
// Main
// ===============================================================================

const SCENARIOS = Number(process.env.RECON_FUZZ_SCENARIOS) || 40;
const STEPS = Number(process.env.RECON_FUZZ_STEPS) || 25;
const BASE_SEED = Number(process.env.RECON_FUZZ_SEED) || 1;

async function main() {
    console.log(`Reconciliation fuzzer — ${SCENARIOS} scenarios × ${STEPS} steps (seed base ${BASE_SEED})`);
    let failed = 0;
    const totals: ScenarioStats = { adopted: 0, virtualized: 0, resized: 0, reads: 0, unmatched: 0, reasons: {} };
    for (let i = 0; i < SCENARIOS; i += 1) {
        const seed = BASE_SEED + i;
        const { violations, stats } = await runScenario(seed, STEPS);
        totals.adopted += stats.adopted;
        totals.virtualized += stats.virtualized;
        totals.resized += stats.resized;
        totals.reads += stats.reads;
        totals.unmatched += stats.unmatched;
        for (const [reason, count] of Object.entries(stats.reasons)) {
            totals.reasons[reason] = (totals.reasons[reason] ?? 0) + count;
        }
        if (violations.length === 0) continue;
        failed += 1;
        console.error(`\n❌ scenario seed=${seed} violated ${violations.length} invariant(s)`);
        if (process.env.RECON_FUZZ_TRACE === '1') {
            const replay = await runScenario(seed, STEPS);
            console.error(`   steps: ${replay.steps.join(' ')}`);
        }
        const minimal = await shrink(seed, STEPS);
        console.error(`   minimal reproduction: RECON_FUZZ_SEED=${seed} RECON_FUZZ_STEPS=${minimal.steps}`);
        for (const line of (minimal.violations.length > 0 ? minimal.violations : violations).slice(0, 8)) {
            console.error(`   ${line}`);
        }
        if (failed >= 3) {
            console.error('\n(stopping after 3 failing scenarios)');
            break;
        }
    }

    // A green run is only meaningful if the scenarios actually moved orders.
    console.log(
        `   coverage: ${totals.reads} reads, ${totals.adopted} placed-slot observations, ` +
        `${totals.virtualized} unbacked-slot observations, ${totals.resized} size changes, ` +
        `${totals.unmatched} reads with unmatched chain orders`
    );
    console.log(`   unmatched reasons: ${JSON.stringify(totals.reasons)}`);
    const strayFloor = Number(process.env.RECON_FUZZ_MIN_STRAY) || Math.max(1, Math.floor(SCENARIOS / 4));
    const strayTotal = (totals.reasons['no-available-nearest-slot'] ?? 0) + (totals.reasons['duplicate-price-level'] ?? 0);
    if (strayTotal < strayFloor) {
        failed += 1;
        console.error(
            `\n❌ stray coverage floor not met: only ${strayTotal} un-adoptable orphans ` +
            `(need ${strayFloor}). The scenarios never reach the reporting branches.`
        );
    }
    const coverageFloor = Number(process.env.RECON_FUZZ_MIN_PLACED) || Math.max(10, SCENARIOS);
    if (totals.adopted < coverageFloor) {
        failed += 1;
        console.error(
            `\n❌ coverage floor not met: only ${totals.adopted} placed-slot observations ` +
            `(need ${coverageFloor}). The scenarios are not exercising reconciliation.`
        );
    }

    if (failed > 0) {
        console.error(`\n❌ ${failed} of ${SCENARIOS} scenarios failed`);
        process.exit(1);
    }
    console.log(`✅ all ${SCENARIOS} scenarios held every invariant`);
}

main().catch((err) => {
    console.error('Fuzzer harness failed:', err);
    process.exit(1);
});
