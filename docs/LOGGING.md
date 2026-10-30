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
| `[GAP-EVAC]` | `order/utils/validate.ts`, `order/manager.ts`, `dexbot_startup_runtime.ts`, `dexbot_state_recovery.ts` | Stuck in-band (gap-band) order streak warnings, cancel-only evacuation teeth, persisted-streak restore counts |
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
| `[SPREAD-CORRECTION] Excluded N candidate(s) from <side> planning: SELL must be above / BUY must be below the last fill ... (the broadcast guard would drop them)` | The planner dropped tightening-edge candidates that the LAST-FILL-GUARD would veto. They were never planned, so no batch is wasted on a guaranteed refusal |
| `[SPREAD-CORRECTION] No placeable <side> slot: every tightening slot is at/through the last fill ...` | Honest no-op: the side cannot be tightened against the last fill (a boundary move or a new fill must restore headroom). Not a batch refusal |
| `[SPREAD-CORRECTION] Fund-constrained promotion on <side>: rotating N resting order(s) into the gap (...)` | Free funds could not fund every promoted gap slot; same-side ACTIVE orders are moved into the unfunded slots at their booked size (no new commitment). The action is a COW UPDATE rotation, never a CREATE. Destinations come from the post-dedupe/post-duplicate-price candidate list |
| `[SPREAD] No fundable side, but a rotation-only repair is available on <side>; using resting inventory (no new commitment).` | Both sides read zero free (or side selection returned no fundable side), but a promoted gap slot can be filled by rotating a resting order. Cross-asset side selection was not overridden when the market price itself was unavailable |
| `[LAST-FILL-GUARD] Skipping <type> UPDATE for <src> -> <dst>: stale gap-evacuation (...) — next plan re-evaluates` | A plan-build gap-evacuation stamp no longer matches the LIVE boundary/gap (or the live probe is not violation-reducing). The op is dropped instead of falling through to the direction-only last-fill guard; the next plan/reconcile owns the move |
| `[LAST-FILL-GUARD] Final gate dropping stale gap-evacuation ...` | The final pre-broadcast pivot gate also refuses a stamp whose live geometry went stale after op-building, even when the destination price itself is direction-legal |
| `[SPREAD-CORRECTION] <side> rail is OVERSUBSCRIBED: virtual reservation X exceeds chain free Y by Z — no correction can be funded until the rail is re-sized ...` | `availableFund` is `free − virtual`, so an oversubscribed rail reads 0 while the side still holds inventory. The watchdog escalates this on its short fund window |
| `[SPREAD-STALE] Spread out of tolerance for Nmin ... (outOfSpread=..., stall=...)` | Persistence warn with the last stall cause; the clock survives single in-tolerance readings and the terminal cases escalate early: `stall=last-fill-blocked` (sell window behind the last fill) on the 10-minute geometry window, a rail oversubscription on the 5-minute fund window |
| `[SPREAD-STALE] ... (sell window behind the last fill — re-centering)` | The `last-fill-blocked` geometry bind is escalating; placement cannot repair it, a re-center can |
| `[BOUNDARY] Re-anchored from the last fill: SELL filled at slot 153 (0.447640); boundary 146 -> 149 so the fill sits outside its own window` | The window was behind the fill and a ±1 crawl cannot catch up; the fill now anchors the geometry. Refusals stay silent (cold/off-ladder/ceiling-clamped/unsafe preconditions); the fill's own PARTIAL residual is allow-listed, so a partial fill does not deadlock the repair |
| `[SPREAD-CORRECTION] sell projection exceeds chain free by 1485.41092974; funding the candidates from chain truth (2171.2 for 2171.2 of ideal size) instead of placing nothing` | The virtual reservation is the projection of these very candidates and is larger than the chain free balance; the correction funds what the chain actually holds instead of deadlocking on a circular budget |
| `[BOUNDARY] Dropped N owed fill crawl(s) (boundary commit): buy=B sell=S net=N±M oldest=Ns kept=M boundary X -> Y` | The commit consumed the records the derivation folded (`kept=M` = records that stayed owed — a capped fold or a re-recorded slot) |
| `[BOUNDARY] Kept N owed fill crawl(s) unconsumed (boundary commit)` | The commit arrived without a consumed-set (a plan that never derived a boundary) or folded nothing it could apply; the records stay owed for the next derivation |
| `Spread correction batch was prepared but not executed. Keeping local state unchanged. (cause=...)` | Terminal refusal; `cause` is the classified `SPREAD_CORRECTION_REFUSAL` value |
| `Shutdown complete. Final metrics: ... spreadCorrectionRefusals=N [cause=count, ...], spreadCorrectionRetries=M` | Refusal breakdown on shutdown; the suffix appears only when at least one refusal occurred |

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
