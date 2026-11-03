# DEXBot2 Logging System

## Quick Start

Edit `profiles/general.settings.json` to configure logging:

```json
{
  "LOG_LEVEL": "info",
  "LOGGING_CONFIG": {
    "categories": {
      "fundChanges": { "enabled": false },
      "orderStateChanges": { "enabled": true },
      "fillEvents": { "enabled": true },
      "boundaryEvents": { "enabled": true }
    }
  }
}
```

### Enable JSON Output

```json
{
  "LOGGING_CONFIG": {
    "json": { "enabled": true }
  }
}
```

Writes JSON lines to log files alongside human-readable console output — zero impact on terminal.

---

## Architecture

All log calls go through the centralized `Logger` class (`modules/order/logger.ts`), which handles console output, batched async file writes, size-based rotation, optional JSON lines, and correlation ID tracing. Callers only interact with `logger.log()`, `logger.info()`, etc. — queueing, rotation, and I/O are internal.

```
Module → Logger.log() ──┬→ console (stdout/stderr)
                        └→ write queue → file (100ms batch)
                              + rotation (total 1.1GB budget, 10 rotated files)
                              + JSON lines (optional)
```

**Under PM2** the console branch is the only active sink: PM2 captures stdout/stderr into `profiles/logs/<app>.log`, so the Logger suppresses its own file writes and its timestamps (PM2's `log_date_format` prefixes each line). Keep console output enabled under PM2 — auto-quieting it would leave PM2 with nothing to capture. Use `quietUnderPm2: true` only if you deliberately want a silent process.

---

## Log Levels

| Level | Value | Default | Color | When It Appears |
|-------|-------|---------|-------|-----------------|
| **debug** | 0 | No | Cyan | Calculation details, fund change tracking |
| **info** | 1 | **Yes** | White | State changes, fills, order placement, boundary events |
| **warn** | 2 | No | Yellow | Non-critical issues, recovery attempts, edge cases |
| **error** | 3 | No | Red | Broadcast failures, sustained fill errors (10+ fails or 5min+) |
| **critical** | 4 | No | Bright red | Fill-consumer cascade (20+ fails or 15min+) — permanent fault signal |

The default `LOG_LEVEL` is `"info"`. For production or minimal output, set to `"warn"` (see the Production config below).

---

## Logging Categories

6 independently enablable categories:

| Category | Default Level | Default | Purpose |
|----------|--------------|---------|---------|
| **fundChanges** | debug | on | Fund balance updates in detail |
| **orderStateChanges** | info | on | Order placement, cancellation, state transitions |
| **fillEvents** | info | on | Fill processing and fund updates |
| **boundaryEvents** | info | on | Grid boundary adjustments and recovery |
| **errorWarnings** | warn | on | Critical issues, all errors and warnings |
| **edgeCases** | warn | on | Unusual conditions that don't cause errors |

### Production config (-90%)

```json
{
  "LOG_LEVEL": "warn",
  "LOGGING_CONFIG": {
    "categories": {
      "fundChanges": { "enabled": false },
      "orderStateChanges": { "enabled": false },
      "fillEvents": { "enabled": false },
      "boundaryEvents": { "enabled": false }
    }
  }
}
```

### Debug config (full verbosity)

```json
{
  "LOG_LEVEL": "debug",
  "LOGGING_CONFIG": {
    "changeTracking": { "enabled": true },
    "categories": {
      "fundChanges": { "enabled": true },
      "orderStateChanges": { "enabled": true },
      "fillEvents": { "enabled": true },
      "boundaryEvents": { "enabled": true },
      "errorWarnings": { "enabled": true },
      "edgeCases": { "enabled": true }
    },
    "display": {
      "fundStatus": { "enabled": true, "showDetailed": true },
      "statusSummary": { "enabled": false }
    }
  }
}
```

---

## Display Features

| Feature | Default | Method | Purpose |
|---------|---------|--------|---------|
| **fundStatus** | off | `logFundsStatus(mgr, ctx, force)` | Detailed fund breakdown |
| **statusSummary** | off | `displayStatus(mgr, force)` | Comprehensive account/order status |

```json
{
  "LOGGING_CONFIG": {
    "display": {
      "fundStatus": { "enabled": true, "showDetailed": true },
      "statusSummary": { "enabled": true }
    }
  }
}
```

---

## Log Rotation

```json
{
  "LOGGING_CONFIG": {
    "rotation": {
      "enabled": true,
      "maxSize": 1181116007,
      "maxFiles": 10
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable/disable rotation |
| `maxSize` | 1.1GB | **Total** disk budget for all log files (current + rotated). Per-file limit = `maxSize / (maxFiles + 1)`. |
| `maxFiles` | `10` | Rotated files to keep; older files pruned |

Example: 1.1GB budget with 10 rotated files → each file rotates at ~100MB, max total ~1.1GB.

Under PM2, the Logger's own file writes and rotation are suppressed — PM2 owns the log files. PM2 core does **not** rotate them (the per-app `max_size` field is ignored), so `dexbot pm2` installs and configures the `pm2-logrotate` module (100M per file, retain 10, compressed) on first start. To manage rotation yourself, install it ahead of time:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 10
```

---

## JSON Structured Output

When enabled, each `log()` call writes a JSON line to the log file:

```json
{"timestamp":"2026-06-12T10:30:00.123Z","level":"INFO","category":"DEXBot","message":"Fill processed: 100 OPEN @ 0.5432","correlationId":"fill-abc-123"}
```

| Field | Always | Description |
|-------|--------|-------------|
| `timestamp` | Yes | ISO 8601 |
| `level` | Yes | Uppercase (`DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL`) |
| `category` | Yes | Logger category |
| `message` | Yes | Raw message, no ANSI codes |
| `correlationId` | No | Present when `setCorrelationId()` was called |

---

## Correlation IDs

Trace a single operation (e.g. a fill) across log lines:

```typescript
logger.setCorrelationId('fill-abc-123');
```

Included in JSON output when present. Propagate to child loggers:

```typescript
const child = new Logger('Accounting', { correlationId: parent.correlationId });
```

---

## Change Detection

`LoggerState` prevents redundant logs by tracking previous values:

- Ignores fund changes < 0.00000001 (8 decimals)
- Ignores price changes < 0.0001 (4 decimals)

| Config Profile | Output Reduction | Lines/Cycle |
|---|---|---|
| Production | 90%+ | ~10 |
| Standard | 40-50% | ~100-150 |
| Debug | 0% | ~200+ |

Force output even if unchanged:

```javascript
manager.logger.logFundsStatus(manager, ctx, true)
manager.logger.displayStatus(manager, true)
```

---

## Log Tags Reference

Prefix tags used in log messages to help operators identify event types. To find every call site of a tag, run: `rg -F "[TAG]" modules/`. This list covers the most operator-visible tags; the full set grows with the codebase.

| Tag | Module | Example |
|-----|--------|---------|
| `[COW]` | `dexbot_cow_runtime.ts`, `order/manager.ts`, `dexbot_state_recovery.ts` | Copy-on-write grid rebalance planning and broadcast |
| `[SYNC]` | `order/sync_engine.ts`, `order/manager.ts` | Blockchain order synchronization |
| `[RECOVERY]` | `dexbot_state_recovery.ts`, `order/accounting.ts` | Fund invariant recovery attempts and resets |
| `[ORPHAN-FILL]` | `dexbot_fill_runtime.ts` | Double-credit prevention for stale-cleaned orders |
| `[HARD-ABORT]` | `dexbot_state_recovery.ts`, `dexbot_class.ts` | Illegal state during batch processing |
| `[FILL-QUEUE]` | `dexbot_fill_runtime.ts` | Fill consumer health, backoff, and escalation |
| `[CREDENTIAL]` | `dexbot_class.ts` | Credential daemon errors, key unlock failures |
| `[BOOTSTRAP]` | `dexbot_fill_runtime.ts` | Startup fill/order reconciliation |
| `[VALIDATION]` | `dexbot_cow_runtime.ts` | Order/config validation errors |
| `[POST-RESET]` | `dexbot_startup_runtime.ts` | Post-AMA-reset fill queue processing |
| `[STALE-CLEANUP]` | `dexbot_fill_runtime.ts` | Pruning expired stale-cleaned order IDs |
| `[SELF-CANCEL]` | `dexbot_fill_runtime.ts` | Skipping non-economic fill artifacts |
| `[FILL-DEDUP]` | `dexbot_fill_runtime.ts` | Fill deduplication events |
| `[MAINT-COOLDOWN]` | `dexbot_maintenance_runtime.ts` | Maintenance cooldown after hard-abort recovery |
| `[DUST]` | `dexbot_maintenance_runtime.ts` | Dust order cancellation, health check, and truncation fallback |
| `[BTS-ACQ]` | `dexbot_maintenance_runtime.ts` | BTS acquisition for non-BTS pairs |
| `[TARGETED-SYNC]` | `dexbot_maintenance_runtime.ts` | Targeted drift synchronization deferral |
| `[MULTI-BOT]` | `chain_orders.ts` | Multi-bot shared-account coordination |
| `[BTS-FEE]` | `order/accounting.ts` | BTS fee deferred accounting |
| `[SPREAD-CORRECTION]` | `order/grid.ts` | Spread correction, plan-time CREATE dedupe, and bounded fresh-master re-plan |
| `[STRATEGY]` | `order/strategy.ts` | Fee event cache and strategy decisions |
| `[RECONCILE]` | `order/utils/validate.ts` | Grid reconciliation ([GRID_RECONCILE.md](GRID_RECONCILE.md)) |
| `[RMS]` | `order/grid.ts`, `dexbot_maintenance_runtime.ts` | RMS structural-divergence checks: per-side `metric vs threshold → TRIGGER-RESYNC/no trigger` at `debug` (plus a `checks disabled` variant when the threshold is 0), reset line with threshold + breaching sides at `info` |
| `[GAP-EVAC]` | `order/utils/validate.ts`, `order/manager.ts`, `dexbot_startup_runtime.ts`, `dexbot_state_recovery.ts`, `dexbot_maintenance_runtime.ts` | Stuck in-band (gap-band) order streak warnings, cancel-only evacuation teeth, persisted-streak restore counts, and the committed-geometry stranding sweep (post-commit + maintenance tick) |
| `[GRID-TYPE-CORRECT]` | `order/grid.ts` | One-time backfill retype of legacy empty slots to rail-typed holes on load |
| `[LAST-FILL-GUARD]` | `dexbot_cow_runtime.ts` | Last-fill-guard blocks plus gap-evacuation bypass allows/stale-stamp downgrades |
| `[RESTAMP-BUY]` | `dexbot_cow_runtime.ts` | BUY emitted at/above the last filled BUY pivot (guard bypass / unjudgeable pivot), counted not blocked (P2) |
| `[COW-GAP-BAND]` | `dexbot_cow_runtime.ts` | SHADOW: non-spread-correction placement inside the plan gap band, counted not blocked (Mode C(a)) |
| `[BOUNDARY-DRIFT]` | `order/strategy.ts` | Derived boundary jumped more than the active window in one plan (P2) |
| `[TRANSPORT]` | `bitshares-native/transport.ts` | WebSocket keep-alive and reconnect |

## 1.4.8 Markers

New/updated operator-visible messages added by the uncertain-broadcast and COW hardening work:

| Message | Meaning |
|---------|---------|
| `[COW] Dropping stale-slot ... > plan boundary ...` | Stale-placement guard vetoed a CREATE/UPDATE that crosses the plan's own target boundary (deferred to next cycle) |
| `[COW] Stale-placement guard removed N placement(s)` | Summary emitted when the guard filters actions |
| `[COW] Plan stale pre-broadcast (...); re-planning once from fresh master` | Pre-broadcast staleness guard fired; bounded re-plan in progress |
| `[COW] Re-plan produced no executable actions; grid is already consistent post-fills, skipping stale plan` | Re-plan confirmed the grid is consistent; the stale plan was not shipped |
| `[COW] Commit refused after broadcast; adopting placed orders from chain` | Master changed mid-broadcast; placed orders adopted so on-chain state converges |
| `[COW] Refusing to commit working grid: base version ... != current ...` | Version-mismatch commit refusal (`evaluateCommit`) |
| `[BROADCAST_DEADLINE]` / `BroadcastUncertainError` | Typed uncertain outcome — the daemon never re-signed; verify-before-retry engages |
| `⚠ FAILED attempt N/3` / `✗ BLACKLISTED after N failures` | Daemon node health ledger — per-node retry exhaustion then blacklist |
| `[DUST] Chain refetch after verified cancel is TRUNCATED/EMPTY; applying local cancel sync` | Truncated-read fallback in the dust-cancel refetch path |
| `authoritative absence verified` | Aligned retry log wording — re-broadcast only on provable absence |
| `Fill channel DEGRADED for <account>: N consecutive history-scan failures … forcing reconnect` | Fill-history channel stayed dead while the socket looked open; the watchdog forced a reconnect (which re-establishes the session and fires the post-reconnect safety-net sync) |
| `Fill channel recovered for <account> [after N forced reconnect(s)]` | A previously degraded channel completed a successful history scan; `N` is how many forced reconnects it took (the clause is omitted when it recovered without an issued reconnect) |
| `processObjects (fill-poll): error … (+N suppressed)` | Throttled fill-channel error; `+N suppressed` counts repeats collapsed within the log interval |
| `processObjects (retry<N>-after-<context>): error …` | Fast re-scan rung fired after a channel failure (ladder 5s/10s/15s), to verify a recovery attempt without waiting for the next 60s poll tick. `N` is the rung |
| `Fill channel for <account> did NOT recover after N forced reconnects … fills may be missed … restart the bot` | **Operator action required.** Automatic recovery ran its full escalation and the channel is still dead — the log line that makes a failed recovery visible instead of a silent reconnect loop |
| `⚠ <node>… FAILED attempt N/3 (fill channel unrecoverable for <account>: …)` | **Node strike recorded.** Emitted only after N forced reconnects failed to clear the channel, i.e. the node itself is suspect. A forced reconnect on its own never costs a node a strike — a session-level wedge that clears on the first cycle leaves the strike ledger untouched. Three of these blacklist the node for 24h |
| `Forcing reconnect on <node> (<reason>)` | Transport-level forced reconnect (stale api_id escalation or fill-channel watchdog); the node is reported failed so the reconnect prefers another node |

### P2 observability + Mode C (2026-10-11)

Counter-only signals (none gate placement) surfaced through `getMetrics()`: `refusedCommitCount`, `orphanFillCreditedCount`, `restampBuyAboveAnchorCount`, `boundaryDriftExceedsWindowCount`, `gapBandPlacementShadowCount`.

| Message | Meaning |
|---------|---------|
| `[COW] Rejecting UPDATE batch pre-broadcast: N target(s) missing on chain (...); grid/chain existence divergence — structural resync required` | Mode C(b): a tracked UPDATE target is gone on chain; the batch aborts cleanly (`UPDATE_TARGET_MISSING`) instead of letting `limit_order_update` abort a chunk mid-broadcast. Followed by a structural resync request |
| `[RESTAMP-BUY] BUY emitted at ... at/above the last filled BUY ...` | A BUY at/above the last filled BUY pivot got past the LAST-FILL-GUARD (bypass or unjudgeable pivot). Counted, not blocked; warned once per batch |
| `[COW-GAP-BAND] shadow: N non-spread-correction placement(s) inside the plan's gap band (...)` | Mode C(a) shadow: an in-gap rail placement that is not spread correction / gap evacuation. Counted, never blocked; warned once per batch |
| `[BOUNDARY-DRIFT] committed boundary X -> planned Y (drift N slots) exceeds active window W; boundary is detached from the market anchor (observability only)` | A single plan moved the boundary more than the active window (absolute recovery anchor or geometry fault). Counted; rate-limited warn |

### Spread-correction resilience

Counter-only signals (none gate placement) surfaced through `getMetrics()`:
`spreadCorrectionRefusedCount` (all refusals), `spreadCorrectionRefusalCauses`
(per-`SPREAD_CORRECTION_REFUSAL` cause), and `spreadCorrectionRetryCount` (bounded
re-plan retries). Kept separate from the generic `refusedCommitCount`.

| Message | Meaning |
|---------|---------|
| `[SPREAD-CORRECTION] Plan-time dedupe: N planned slot(s) occupied since planning (...); re-planning from fresh master` | A planned CREATE destination was taken after planning; the plan is re-derived from fresh master |
| `[SPREAD-CORRECTION] Plan-time dedupe: ...; no re-plan candidate — refusing this cycle` | Collision detected but no fresh candidate exists; the colliding plan is withheld (never broadcast) |
| `[SPREAD-CORRECTION] Batch refused (cause); re-planning from fresh master (attempt 2/2)` | Transient refusal; the bounded fresh-master re-plan is in progress |
| `[SPREAD-CORRECTION] Excluded N candidate(s) from <side> planning: SELL must be above / BUY must be below the last fill ... (the broadcast guard would drop them)` | The planner dropped tightening-edge candidates that the LAST-FILL-GUARD would veto. They were never planned, so no batch is wasted on a guaranteed refusal. `N` counts candidate SLOTS, not pool visits — an empty in-rail slot qualifies for both the SPREAD pool and the orphan pool, and counting visits reported every vetoed slot twice (SLF-13) |
| `[SPREAD-CORRECTION] No placeable <side> slot: every tightening slot is at/through the last fill ...` | Honest no-op: the side cannot be tightened against the last fill (a boundary move or a new fill must restore headroom). Not a batch refusal |
| `[SPREAD-CORRECTION] Fund-constrained promotion on <side>: rotating N resting order(s) into the gap (...)` | Free funds could not fund every promoted gap slot; same-side ACTIVE orders are moved into the unfunded slots at their booked size (no new commitment). The action is a COW UPDATE rotation, never a CREATE. Destinations come from the post-dedupe/post-duplicate-price candidate list |
| `[SPREAD] No fundable side, but a rotation-only repair is available on <side>; using resting inventory (no new commitment).` | Both sides read zero free (or side selection returned no fundable side), but a promoted gap slot can be filled by rotating a resting order. Cross-asset side selection was not overridden when the market price itself was unavailable |
| `[LAST-FILL-GUARD] Skipping <type> UPDATE for <src> -> <dst>: stale gap-evacuation (...) — next plan re-evaluates` | A plan-build gap-evacuation stamp no longer matches the LIVE boundary/gap (or the live probe is not violation-reducing). The op is dropped instead of falling through to the direction-only last-fill guard; the next plan/reconcile owns the move |
| `[LAST-FILL-GUARD] Final gate dropping stale gap-evacuation ...` | The final pre-broadcast pivot gate also refuses a stamp whose live geometry went stale after op-building, even when the destination price itself is direction-legal |
| `[LAST-FILL-GUARD] Stamped evacuation for <src> -> <dst> is stale under live boundary B/gap G, but the live rails already conflict (maxBuy=X > minSell-gap-1=Y) — the retreat this batch commits is forced, so the evacuation proceeds` | Forced-retreat allowance (`liveRailsConflictWithGap`). The stale-stamp refusal assumes the live boundary survives the commit; when the live rails already overlap, NO boundary can host both rails with the gap band, so the batch's retreat is the only consistent geometry and refusing the evacuation is what permanently strands the order in the band (spread collapse). The same allowance is applied by the build loop and by the final pivot gate |
| `[LAST-FILL-GUARD] Final gate keeping gap-evacuation ... despite live boundary B/gap G: the live rails already conflict ...` | The final-gate mirror of the forced-retreat allowance above (keeping the op is violation-reducing, not a guard bypass) |
| `[GAP-EVAC] N live order(s) stranded inside the spread band (boundary B, gap G): <slot(side), ...> — scheduling a fill-less re-plan to evacuate (<context>)` | Post-commit / maintenance sweep: live rail orders are resting inside the committed band, so the real top-of-book spread is narrower than the configured one. A fill-less COW re-plan runs against the committed geometry (where the evacuation stamp validates) — plans are fill-driven, so a quiet market would otherwise never heal. Rate-limited (60s) per bot; repeats inside the window log at `debug` |
| `[GAP-EVAC] ... repair cooldown active (Ns left); teeth queued=N` | The sweep found the same stranding again inside the repair cooldown window; the cancel-only teeth remain the last resort |
| `[COW] Holding N gap-evacuation cancel(s) back from the pre-batch drain: this batch rotates the same chain order (the rotation IS the evacuation)` | A cancel-only evacuation queued for a chain order the current batch rotates. Draining it first would cancel the batch's own rotation source and the UPDATE batch would be rejected pre-broadcast (`target(s) missing on chain` → structural resync). The entry is restored after the drain and dropped as stale once the slot no longer owns the order |
| `[GAP-EVAC] Spread band clean: cleared N resolved in-band streak(s)` | The sweep found no live order inside the committed band and dropped N resolved ledger entries, so a future return to the band re-arms instead of inheriting a stale cycle count. Logged only when something was actually cleared |
| `[GAP-EVAC] ... unknown geometry` (silent) | With no committed boundary (or no known band width) the sweep returns without touching the ledger or the pipeline: absent geometry is not health, it is unknown |
| `[GAP-EVAC] ... no fill-less re-plan available on this path; teeth queued=N` | The stranding is real but this bot shape cannot run a fill-less rebalance (no `performSafeRebalance`/`updateOrdersOnChainBatch`); the cancel-only teeth own the repair |
| `[BOUNDARY] restore boundary=B sellStart=S gapSlots=G spreadCount=N\|? activeBuy=... activeSell=...` | Boundary restore telemetry. `gapSlots` is the resolved geometry (`_gapSlots ?? config-derived`) — never `0` for an unpublished band — and `spreadCount=?` means the grid has not been loaded/created yet, so no spread metric exists. A literal `gapSlots=0 sellStart=B+1` now always means a genuinely 0-wide band, not an initialization window |
| `[SPREAD-CORRECTION] <side> rail is OVERSUBSCRIBED: virtual reservation X exceeds chain free Y by Z — no correction can be funded until the rail is re-sized ...` | `availableFund` is `free − virtual`, so an oversubscribed rail reads 0 while the side still holds inventory. The watchdog escalates this on its short fund window |
| `[SPREAD-STALE] Spread out of tolerance for Nmin ... (outOfSpread=..., stall=...)` | Persistence warn with the last stall cause; the clock survives single in-tolerance readings and the terminal cases escalate early: `stall=last-fill-blocked` (sell window behind the last fill) on the 10-minute geometry window, a rail oversubscription on the 5-minute fund window |
| `[SPREAD-STALE] ... (sell window behind the last fill — re-centering)` | The `last-fill-blocked` geometry bind is escalating; placement cannot repair it, a re-center can |
| `[SPREAD-STALE] Still out of tolerance Nmin after re-centering on fill pivot P: the pivot is outside this generation's placeable side, so a re-center cannot clear it. A fill ... or pivot expiry restores the side; no further re-center will be requested for this pivot.` | Churn cap: a re-center does not move the pivot, so the same fill gets ONE re-center (`_lastGeometryResyncPivotKey`). Logged once per pivot; the same-side rail stays blocked until a fill or the read-time 24h pivot TTL, by design |
| `[BOUNDARY] Re-anchored from the last fill: SELL filled at slot 153 (0.447640); boundary 146 -> 149 so the fill sits outside its own window` | The window was behind the fill and a ±1 crawl cannot catch up; the fill now anchors the geometry. The anchor is the current fill batch's extremum for that side (max SELL / min BUY), not the last-processed pivot. Refusals stay silent (cold/off-ladder/ceiling-clamped/unsafe preconditions); the fill's own PARTIAL residual at the ANCHOR slot is allow-listed, so a partial fill does not deadlock the repair |
| `[BOUNDARY] Re-anchor accepted as a violation-reducing repair: boundary X -> Y strands fewer placed orders than the committed geometry (placed_order_in_band)` | The strict gate refused the candidate only because older GAP-EVAC strands are still in band; the move strands STRICTLY FEWER than the committed boundary, so it is accepted. Equal counts and structural refusals (crossed book/ceiling) stay closed. The rule lives in ONE helper (`boundaryMoveReducesStrands`) shared with the rail clamp — see `[COW] Boundary rail-derived` below. The promotion-side counterpart is the in-band absorption logged as `[SPREAD-CORRECTION] N gap slot(s) available for boundary promotion` |
| `[PLACEMENT] Force-releasing stale placement region held by <kind> for Ns (watchdog Ms); fills/rebalances must not stay parked` | The exclusive placement region outlived `TIMING.PLACEMENT_STALE_CLEAR_MS` (generous: above the longest observed reconcile), so the lease is force-released; the holder's later `release()` becomes a no-op (token guard). This watchdog is the ONE authority that tears a hung region down — when the region also still holds a stale broadcast refcount, it clears that too (`[PLACEMENT] Also clearing the stale broadcast region ...; one teardown for one hung region`) |
| `[COW] Placement lease was force-released while this batch was in flight (stale-region watchdog); aborting this batch instead of broadcasting without the region.` | The owner re-verifies its own lease with `isPlacementLeaseCurrent()` before broadcasting — the mirror of the nested drain's check. Aborting is the fail-closed answer: another path may own the region by now, and broadcasting anyway re-opens the duplicate window the teardown existed to avoid |
| `Startup reconcile: placement lease was force-released after planning (stale-region watchdog); discarding the plan instead of broadcasting without the region.` | The reconcile's own lease-liveness gate before Phase 2 (the mirror of `[COW] Placement lease was force-released ...`). Phase 1 touched only the master, so the plan is dropped with no chain effect; the next cycle re-reads the chain after re-acquiring the region |
| `[PLACEMENT] Watchdog skipped: region held by <kind> for Ns, but the pipeline is still making progress (in flight Ms)` | A bot-level batch/recovery counter younger than the placement bound proves the region is live (e.g. a long create-group reconcile), so nothing is torn down. Only a counter past the same bound is treated as part of the hung region |
| `[COW] <stage>: exclusive placement region unavailable (timeout/shutdown); aborting this batch instead of overlapping another placement path.` | Another chain-mutating path owns the region and the bounded wait expired. The batch is aborted (never broadcast unprotected) and retried on the next cycle |
| `Startup reconcile: exclusive placement region unavailable (timeout/shutdown); deferring to the next sync cycle.` | The reconcile could not serialize with a live placement path; it returns without mutating anything |
| `[DUST] Deferring dust cancels: exclusive placement region busy or shutting down` | Dust cancels mutate the chain, so they need the region. Deferral (not a bypass) is the contract; the next fill batch / maintenance tick retries |
| `[RESIDUAL] Deferring N residual cancel(s): exclusive placement region busy or shutting down` | Sub-dust residual cancels after a full fill are deferred to the next sync/reconcile instead of racing a live batch |
| `[MAINT] Deferring price-correction drain: exclusive placement region busy or shutting down` / `[FILL-QUEUE] Deferring price-correction drain: ...` / `[COW] Draining N pending correction(s) before batch` | The correction drain runs inside the region (nested callers pass the holder's lease, verified with `isPlacementLeaseCurrent`). A deferred drain keeps its queued entries for the next tick; the fill consumer and the maintenance tick report the same deferral under their own tags |
| `[BROADCAST] Stale-flag watchdog skipped: placement region still held by <kind> for Ns` | The refcount watchdog refuses to clear a broadcast region a live placement lease still owns — the mirror rule of the placement watchdog's pipeline-progress check |
| `[REBUILD] Structural rebuild started (<reason>); fill-driven rebalances deferred` | A trigger-file/startup rebuild owns placement and update-first repair; fill-driven COW rebalances defer instead of re-planning against the order-id-less master |
| `[SAFE-REBALANCE] Deferred: placement region held by <kind>; rebalance retries after it ends` | A fill-driven rebalance found the region held (reconcile/drain/dust/cancel/swap). The owed fill crawls stay recorded and the region-end hook reschedules the no-fill rebalance |
| `[FILL-DEDUP] Fill <key>: N/M base units already absorbed by sync pass 1; the transition will not shrink them again` | The open-orders pass resized the slot from the same post-fill snapshot. The explicit applied amount (never the legacy boolean) drives the remainder, so the trade's pays/receives are still booked while the size is released exactly once |
| `[COW] Pending-broadcast entry <fp> is Ns old but no sync has completed since it was recorded; keeping it (fail-closed) until a caught-up read` / `[COW] Dropped expired pending-broadcast entry ...` | The single pending-broadcast liveness authority (`getLivePendingBroadcasts`): TTL, or TTL + a successful sync after the record, or the 2× hard cap. Every reader (COW guard, reconcile CREATE, reconcile surplus sweep, crossing candidates) obeys it |
| `[FILL-PIVOT] pivot=... buy=... sell=... n=N src=full/direct` (+ `edge-skipped=K` when present) | One line per fill batch: the LAST-FILL-GUARD pivot after the batch. `edge-skipped=K` means K edge-pinned insurance fills were ignored — they never arm the pivot, so they can never drive the re-anchor |
| `[FILL-PIVOT] K edge-pinned fill(s) ignored — the guard pivot and the boundary anchor stay on the last window trade` | Edge-only batch: nothing armed, which is the point |
| `[LAST-FILL-GUARD] Re-armed on the new generation: 0.447640(SELL) from the last real fill (age Ns) — the guard survives a rebuild by design` | A grid rebuild dropped the generation-bound pivot and re-armed it explicitly from the bot-scoped last-market-fill row (`rearmLastFillPivotFromMarketFill`). Provenance stays `fill`; the timestamp is the original fill's, taken from the SAME row that supplied the price (a book-seeded live pivot never lends its clock) |
| `[LAST-FILL-GUARD] Pivot expired (age Ns > TTL Ms) — guard re-arms on the next fill` | Read-time pivot lifetime: a fill reference older than `GRID_LIMITS.LAST_FILL_PIVOT_TTL_MS` no longer arms the guard, with or without a restart. Logged once per expired value, so the geometry-bind re-center cap cannot silently park a side forever |
| `[COW-CROSS-GUARD] CREATE SELL for slot-N at P sits on the crossing side of the floor F (the planner refuses these; a generic refill does not) — it executes at the best available price, so this is a taker-fee observation, not a veto. Once per batch.` | Planner/execution asymmetry made visible: `doesNotCrossMarket` is planner-only, so a reconcile/re-fill CREATE can be a taker fill. Never blocking by design (a hard veto would re-open the counter-order deadlock) |
| `[COW] Boundary rail-derived: planned X, held Y -> Z (maxBuy=..., minSell=...) — keeping placed counter orders on their rails` | The batch's own rails disagree with the boundary a refill hold would commit. `deriveRailBoundary` clamps to `maxBuy <= boundary <= minSell-gap-1`, so a fill's counter order carries the boundary instead of being stranded in the band. The refill hold still applies when nothing was placed above the committed boundary. The reason suffix `(N stray rail order(s) ignored)` names master orders parked on the wrong side (refused-commit adoption / stranded hold), and `window=K` reports the grid's claimed window size |
| `[COW] Boundary rail-derived: unusable (rail-crossed ... / rail-exceeds-grid ...); keeping Z` | The live/placed rails already overlap or cannot fit the gap band. Fail closed: keep the previous boundary and let GAP-EVAC / the next plan resolve the offending order (never self-legalize a crossed rail) |
| `[COW] Boundary rail-derived: unusable (unsafe: placed_order_in_band ...); keeping Z` | The shared `validatePersistedBoundary` gate refused the clamped value (it would strand a placed order in the implied band). Same validator as the restore/commit paths and the fill re-anchor; the only get-out is the batch vacating the slot |
| `[SYNC] Gap-evacuation queued for <orderId> (slot <slot>): live price P maps inside the gap band (boundary B, gap G) — cancelling instead of re-pricing` | A chain price mismatch is actually an in-band placement: the live price maps between the boundary and sellStart. Queued as a cancel-only evacuation, and any plain re-price entry for the same chain order is dropped so the two cannot race |
| `[SPREAD-CORRECTION] sell projection exceeds chain free by 1485.41092974; funding the candidates from chain truth (2171.2 for 2171.2 of ideal size) instead of placing nothing` | The virtual reservation is the projection of these very candidates and is larger than the chain free balance; the correction funds what the chain actually holds instead of deadlocking on a circular budget |
| `[BOUNDARY] Dropped N owed fill crawl(s) (boundary commit): buy=B sell=S net=N±M oldest=Ns kept=M boundary X -> Y` | The commit consumed the records the derivation folded (`kept=M` = records that stayed owed — a capped fold or a re-recorded slot) |
| `[BOUNDARY] Kept N owed fill crawl(s) unconsumed (boundary commit)` | The commit arrived without a consumed-set (a plan that never derived a boundary) or folded nothing it could apply; the records stay owed for the next derivation |
| `Spread correction batch was prepared but not executed. Keeping local state unchanged. (cause=...)` | Terminal refusal; `cause` is the classified `SPREAD_CORRECTION_REFUSAL` value |
| `Shutdown complete. Final metrics: ... spreadCorrectionRefusals=N [cause=count, ...], spreadCorrectionRetries=M` | Refusal breakdown on shutdown; the suffix appears only when at least one refusal occurred |

---

## Fill discipline at the reconcile / placement sites

Added with the buy-higher fix (2026-11-02: 9 buy-lower violations, 23.5% of the
window's BTS). See `docs/GRID_RECONCILE.md#fill-discipline-unsettled-fills--last-fill-placement`.

| Message | Meaning |
|---------|---------|
| `[SYNC] Fill for order <id> attributed to <slot> via chain-id\|ladder (<side> @ P): pivot recorded + owed boundary crawl` (suffix `(slot still holds a live order: no crawl)` when applicable) | The fill's order id identified no ACTIVE/PARTIAL slot. `via=chain-id` means a virtualised slot still owned the id; `via=ladder` means the id was already cleared (every virtualisation NULLS it) and the **execution price** resolved the level through the genesis ladder. The pivot moves to that price unless the writer skips the fill as edge-pinned (a wick on the static floor/ceiling must never arm the guard — the line then reads `pivot NOT armed`); the crawl is only owed by a HOLE the grid owns, because an occupied level cannot be re-placed. A price outside the frozen rail is refused here, so a shelf/manual order can never arm the pivot. Previously this was a silent `ignored: order not found in active grid` at `debug` — the stale pivot it left behind is what let the reconciler re-buy above the market |
| `[SYNC] Revived virtualised slot <slot>: its chain order <id> is still live (<side> @ P, size S) while the slot was VIRTUAL — re-materialised in place (no broadcast), so window accounting counts it again` | The dark-level repair: a slot virtualised while its order stayed on chain (phantom cleanup on a truncated read, refused-commit adoption) is invisible to window accounting while its order still counts in `chainCount`. Master-only revive, only when the chain order rests at that slot's level — a rotation alias (different level) is never resurrected |
| `[SYNC] Revive of virtualised slot <slot> rejected — slot keeps its VIRTUAL state` | `_applyOrderUpdate` refused the revive; nothing is booked and the next sync re-detects |
| `[SYNC] Cleared stale chain id <id> on <slot> (slot was VIRTUAL): the order is gone from the chain read, so the level is a normal hole again — no fill booked` | A non-placed slot carried an id whose order is absent from a trusted read. The id is dropped WITHOUT booking a fill (inventing one would arm the pivot and crawl for a trade that never happened). This is what keeps the CREATE occupancy gate from stranding a level |
| (same `[SYNC] Revived virtualised slot ...` line) | Emitted by BOTH call sites: sync pass 1 (`sync-pass1-revive`) and reconcile Phase 1 (`startup-revive`, before the plan is derived so the side no longer reads a phantom shortfall) |
| `[TARGETED-SYNC] Deferring <context> reconciliation: <reason> — the rail must absorb the fills before it is topped up` | A targeted reconcile was requested while fills are queued/draining/in flight/owed a crawl. No cooldown is stamped, so it retries as soon as they settle |
| `Startup: Deferring N <side> window top-up create(s): <reason> — the rail must absorb the fills before it is refilled` | Same gate on the reconcile side. 1:1 repairs (cancelled-slot replacement, vacated-rail refill) are still planned; only the window top-up waits |
| `Startup: <side> pick skipped N slot(s) on the wrong side of the last fill (pivot P); picked X/Y` | The activation picker refused candidates the placement guard would block, so the pick rolls to the next level down (BUY) / up (SELL). `picked X/Y` below target means the rail had no legal level left this cycle |
| `[_createOrderFromGrid] SKIP (LAST-FILL-GUARD): Create for <slot> at P on the wrong side of the last fill F (<reason>); the rail must crawl before this level is refilled` | A reconcile create was refused before any broadcast. `reason` is `direction` (wrong side) or `same-level` (within half a grid step — a slot level and its execution price differ by rounding) |
| `Startup: Skip create <label> (LAST-FILL-GUARD) - price P ...` | Same refusal in the batch create path |
| `[STARTUP-LAST-FILL-GUARD] Skipping relocation update <orderId> -> <slot>: target ... is on the wrong side of the last fill F (<reason>); re-align on the next reconcile cycle` | A re-pricing relocation is a placement too. Same-price relocations are adoptions and are exempt |

---

## Fill History Scan Profiling

The `Subscriptions` logger emits `fetchFillHistoryEntries: maxPages (X) reached` at `debug` level when the fill-history scan reaches its configured page cap. On a busy account this is **normal** — the scan simply catches up over multiple polling cycles rather than in a single pass.

If the message recurs across many cycles **without any new fills being detected** (i.e. `maxPages` is hit but `highestReceived` never advances), the connected witness node is likely running with `--partial-operations` pruning enabled. This removes old `operation_history_objects` from the `by_op` index, so the scan can never re-fill the gap because the entries no longer exist on-chain.

**Operator checklist:**
1. Confirm the node config does not enable `--partial-operations` (or that the retention window covers the gap).
2. Restart the node after adjusting the config so the full `by_op` index is rebuilt.
3. If a full node is unavailable, point the bot at an archive endpoint for the initial history scan; subsequent incremental scans only need recent history.

---

## FAQ

**Q: How much output reduction can I expect?**
- Standard config: 40-50%
- Production config: 90%+
- Debug config: 0% (all logs)

**Q: Do I need to change my code?**
No. All existing `logger.log()` calls work unchanged.

**Q: How is config loaded?**
Defaults in `modules/constants.ts` → deep merged with `profiles/general.settings.json` → frozen (immutable).

**Q: Can I customize logging per bot?**
Yes — each bot entry in `profiles/bots.json` accepts an optional `logging` field:

```json
{
  "name": "EXAMPLE-BOT",
  "logging": {
    "level": "debug",
    "config": {
      "json": { "enabled": true },
      "categories": {
        "fundChanges": { "enabled": false }
      }
    }
  },
  ...
}
```

The per-bot `logging` is deep-merged on top of the global config from `general.settings.json`. See `modules/runtime_settings.ts` for the merge logic and `modules/order/manager.ts` for where the merged config reaches the logger.

**Q: What about PM2?**
The logger auto-detects PM2 and suppresses its own file writes because PM2 captures stdout/stderr into `profiles/logs/<app>.log`. It never auto-quiets under PM2 (that would drop every line — stdout is the only sink). Log rotation moves to `pm2-logrotate`, which `dexbot pm2` installs automatically on first start.

**Q: Are log lines lost on crash?**
Queued-but-unwritten lines could be lost. Critical errors go to stderr immediately (PM2 captures those). Queue drains every 100ms. Call `flush()` on shutdown.
