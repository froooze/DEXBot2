/**
 * DEXBot2 Central Type Definitions
 *
 * Where possible, types align with the BitShares C++ protocol headers
 * at https://github.com/bitshares/bitshares-core
 *
 * See libraries/protocol/include/graphene/protocol/ for canonical defs.
 */

// ============================================================
// STRING LITERAL ENUMS
// ============================================================

export type OrderType = 'sell' | 'buy' | 'spread';
export type OrderState = 'virtual' | 'active' | 'partial';

/**
 * Why a spread correction placed no effective order. Carried from
 * checkSpreadCondition to the maintenance loop so the funds/open-orders refresh
 * is requested only when it can repair the cause, and so the log states the
 * truth instead of always blaming free funds.
 *
 *   no-free-funds     — determineOrderSideByFunds found no fundable side.
 *   unfunded          — candidates existed but free funds funded none.
 *   no-candidates     — no spread-tightening slot exists in the LOCAL snapshot.
 *                       This can be genuine structural geometry, or a stale
 *                       local order state (a missed fill leaves an ACTIVE slot
 *                       occupying the window edge, hiding the tightening slot
 *                       behind it). Only a chain sync can tell the two apart,
 *                       so it arms the refresh too; the out-of-spread staleness
 *                       watchdog remains the backstop if the sync heals nothing.
 *   cold-book         — no live order on either side (readiness P-A): there is
 *                       no realized spread to repair. The reconcile path owns
 *                       the first window; a targeted sync is armed.
 *   unmatched-orders  — readiness P-C: the only tightening candidates collided
 *                       with known-unmatched chain orders, so planning skipped
 *                       them and let the sync adopt them first.
 *   readiness-gate    — the readiness gate itself failed (threw), so the cycle
 *                       was refused correct-by-refusal. A fault to triage, not
 *                       a structural candidate condition.
 *   batch-not-executed— a plan was prepared but the COW batch did not run.
 *   apply-error       — the broadcast threw.
 *
 * ('stale-snapshot' is degraded-ok, not a stall: the planner still acts, it
 *  only withholds the LAST-FILL-GUARD bypass.)
 */
export type SpreadCorrectionStall =
    | 'no-free-funds'
    | 'unfunded'
    | 'no-candidates'
    | 'cold-book'
    | 'unmatched-orders'
    | 'readiness-gate'
    | 'batch-not-executed'
    | 'apply-error'
    /**
     * Every tightening slot on the corrected side is at/through the last fill
     * (SELL at/below it, BUY at/above it), so placement cannot repair the side:
     * the bind is the grid WINDOW (a sell slot below the last sale means the
     * boundary/crawl is behind the fill), not a missing candidate. Escalates on
     * the short geometry window instead of the structural one.
     */
    | 'last-fill-blocked';

// ============================================================
// SHARED PRIMITIVES (replacements for explicit `any`)
// ============================================================

/**
 * Dict with unknown values. The canonical replacement for
 * `Record<string, any>`; callers must narrow a value before using it.
 */
export type UnknownRecord = Record<string, unknown>;

/** A value that survives JSON round-tripping. */
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Function-shaped logger callback. `level` is intentionally an open string:
 * call sites use labels such as `info`, `warn`, `error`, `debug`.
 */
export type LogFn = (message: string, level?: string) => void;

/**
 * Anything logger-like. Mirrors how callers use injected loggers
 * (`logger?.log?.()` / `logger.warn?.()`).
 */
export interface LoggerLike {
  log?: LogFn;
  warn?: LogFn;
  info?: LogFn;
  debug?: LogFn;
  error?: LogFn;
}

/**
 * The `{ promise, resolve, reject }` pattern used by async gates.
 * Prefer this over hand-rolled `Promise<any>` + `any` callbacks.
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/** Runtime narrowing guard for `UnknownRecord` at I/O boundaries. */
export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ============================================================
// DOMAIN: BITSHARES CHAIN OBJECTS
// ============================================================

/** Graphene `asset_amount` (e.g. `{ amount: 12345, asset_id: '1.3.0' }`). */
interface ChainAssetAmount {
  amount: number | string;
  asset_id: string;
}

/** Graphene `price` (sell_price.base / sell_price.quote). */
interface ChainPrice {
  base: ChainAssetAmount;
  quote: ChainAssetAmount;
}

/**
 * A raw BitShares `limit_order_object` as returned by the node (before
 * `parseChainOrder` converts it to a grid `Order`). Extra protocol fields
 * remain accessible via the index signature.
 */
export interface ChainOrder {
  id: string;
  seller?: string;
  sell_price: ChainPrice;
  for_sale: number | string;
  expiration?: string;
  [key: string]: unknown;
}

/** The result of `parseChainOrder()`: a chain order normalized to grid terms. */
export interface ParsedChainOrder {
  orderId: string;
  price: number;
  type: OrderType;
  size: number | undefined;
}

/** A raw chain order paired with its parsed form (holds the pre-filter join). */
export interface ParsedChainEntry {
  chain: ChainOrder;
  parsed: ParsedChainOrder;
}

/**
 * The subset of the `chain_orders` module surface the order engine calls.
 * Methods are variadic (`unknown` args) because their real parameter lists are
 * still being typed; the named members keep them callable without `any`.
 */
export interface ChainOrdersLike {
  cancelOrder(...args: unknown[]): Promise<{ verifiedAfterFailure?: boolean; [key: string]: unknown } | null | undefined>;
  createOrder(...args: unknown[]): Promise<{ skipped?: boolean; [key: string]: unknown } | null | undefined>;
  readOpenOrders(...args: unknown[]): Promise<unknown>;
  buildUpdateOrderOp?(...args: unknown[]): Promise<{ op?: unknown; [key: string]: unknown } | null | undefined>;
  executeBatch?(...args: unknown[]): Promise<unknown>;
  updateOrder?(...args: unknown[]): Promise<{ [key: string]: unknown } | null | undefined>;
  wasRecentlyOwnCancelled?(orderId: string): boolean;
  [key: string]: unknown;
}

/**
 * Minimal runtime surface shared by the `dexbot_*_runtime.ts` layer. This is
 * a seeded interface to grow as each runtime file is typed — the index
 * signature keeps the many `_camelCase` internals reachable (as `unknown`)
 * while the common surface gets real types. Replace index-signature reads with
 * named fields as the relevant owners are typed.
 */
/**
 * The DexBot runtime surface used by the `dexbot_*_runtime.ts` layer (and the
 * `DexBot` class itself, which structurally satisfies it). No index signature:
 * every member the runtime touches is enumerated, so a typo or an undeclared
 * internal is a compile error instead of a silent `unknown`.
 */
/** Credential-daemon signing token (used until the private key is unlocked). */
export interface SigningToken {
  accountName: string;
  socketPath?: string;
}

export interface BotLike {

  // --- identity / config ---
  config: GridConfig;
  manager: OrderManagerLike;
  account: string | null;
  accountId: string | null;
  privateKey: string | SigningToken | null;
  accountOrders: AccountOrdersLike;
  assets: AssetPair | null;
  botKey: string;
  name: string;
  triggerFile: string;
  logPrefix: string;
  _log: LogFn;
  _warn: LogFn;

  // --- state / counters ---
  _baseWeightDistribution: { sell: number; buy: number };
  _metrics: BotMetrics;
  _recentlyQueuedFills: Map<string, number>;
  _recentlyProcessedFills: Map<string, number>;
  _incomingFillQueue: IncomingFill[];
  _processedFillStore: ProcessedFillStoreLike;
  _staleCleanedOrderIds: Map<string, number>;
  _staleCleanupRetentionMs: number;
  _fillCleanupCounter: number;
  _fillDedupeWindowMs: number;
  _fillRecordRetentionMs: number;
  _targetedDriftSyncCooldownMs: number;
  _maintenanceCooldownCycles: number;
  _lastGridActivityAt: number;
  _currentCycleId: number;
  _consecutiveConsumeFailures: number;
  _consumeFailureFirstAt: number;
  _fillTotalsRetryAttempt: number;
  _gridPriceInvariantRejectStreak: Map<string, number>;
  _structuralGridResyncRunning: number;
  _structuralGridResyncDeferCount: number;
  _structuralGridResyncDeferStartedAt: number | null;
  _postRecoveryRebalanceDefers: number;
  _lastDeferredDustCount: number;
  _deferredFillRetryWaits: number;
  _deferredFillRetryDelayMs: number;
  _lastTargetedDriftSyncAt: number;
  _lightweightSyncCheckAt: number;
  _lastUncertainResyncAt: number;
  _lastResolvedPollIntervalMs: number;
  _fillBroadcastDeferSince: number;
  _fillBroadcastDeferRegionAt: number;
  _fillTotalsParkedFills: IncomingFill[];
  _fillTotalsRetryTimer: ReturnType<typeof setTimeout> | null;
  _fillTotalsRetryDelayMs: number;
  _currentBatchId: string | number | null | undefined;
  _lastBroadcastHeartbeatAt: number | undefined;
  _appliedBotConfigFingerprint: string | null;
  _lastBotConfigHintFingerprint: string | null;
  _marketAdapterWatchdogFingerprint: string | null;
  _lastHeldChainOrderSignature: string | null;
  _lastHeldChainOrderSignatureSince: number;
  _lastHeldChainOrderWarnAt: number;
  _lastDeferredHoldResyncAt: number;
  _lastGridPriceInvariantResyncAt: number;
  _lastSpreadStaleResyncAt: number;
  /**
   * Fill pivot (`price|type`) the geometry-bind (`last-fill-blocked`) escalation
   * already re-centered for. A re-center does not move the pivot, so a second
   * request on the same fill only churns the new generation; cleared whenever
   * the spread heals.
   */
  _lastGeometryResyncPivotKey: string;
  /** Pivot key the "re-center cannot clear this pivot" warning was logged for. */
  _geometryResyncWarnedPivotKey: string;
  _gridLockHoldWarnAt: number;
  _outOfSpreadSince: number;
  _outOfSpreadStaleWarned: boolean;
  _outOfSpreadTransientCount: number;
  /**
   * Timestamp when the spread first read within tolerance. Cleared on any
   * out-of-tolerance cycle. A single good reading no longer clears the
   * persistence clock — it must hold for SPREAD_STALE_IN_TOLERANCE_RESET_MS.
   */
  _outOfSpreadToleranceSince: number;
  _strandedHoldSince: Map<string, number>;
  _recoverySyncInFlight: number;
  _batchInFlight: number;
  _cowBroadcastInFlight: boolean;
  _deferredFillsPending: boolean;
  _credentialRecoveryNeeded: boolean;
  _shuttingDown: boolean;
  _mainLoopActive: boolean;
  _botsConfigPollInFlight: boolean;
  _marketAdapterWatchdogInFlight: boolean;
  _blockchainFetchInFlight: number;
  _blockchainFetchIntervalMin: number;
  /**
   * A spread-correction stall was mirrored this cycle. ANY cause arms the
   * targeted chain refresh (a missed fill can hide the tightening slot, a stale
   * hold can zero the funds), so the flag is cause-agnostic — the cause itself
   * is carried in `_spreadCorrectionStall`. Formerly `_spreadFundsExhausted`,
   * which mislabelled geometry stalls as fund stalls.
   */
  _spreadStallArmed: boolean;
  _spreadCorrectionStall: SpreadCorrectionStall | null;
  _skipEmptyReadConfirmDelay: boolean;
  _testPollIntervalMs?: number;
  _appliedBotConfigEntry: unknown;
  _creditRuntime: CreditRuntimeLike | null;
  _gridModule: unknown;
  _gridReconcileModule: unknown;

  // --- handles / timers ---
  _blockchainFetchInterval: ReturnType<typeof setInterval> | null;
  _botsConfigPollInterval: ReturnType<typeof setInterval> | null;
  _credentialDaemonWatchdogInterval: ReturnType<typeof setInterval> | null;
  _creditWatchdogInterval: ReturnType<typeof setInterval> | null;
  _dustHealthCheckTimer: ReturnType<typeof setInterval> | null;
  _deferredFillRetryTimer: ReturnType<typeof setTimeout> | null;
  _postRecoveryRebalanceTimer: ReturnType<typeof setTimeout> | null;
  _structuralGridResyncTimer: ReturnType<typeof setTimeout> | null;
  _triggerDebounceTimer: ReturnType<typeof setTimeout> | null;
  _fillsUnsubscribe: (() => Promise<unknown>) | null;
  _reconnectUnregister: (() => void) | null;
  _triggerWatcher: { close?: () => void } | null;
  _mainLoopPromise: Promise<unknown> | null;

  // --- operations (typed by tsc-driven refinement; broad to start) ---
  _abortFlowIfIllegalState(...args: unknown[]): unknown;
  _applyRecoverableGridUpdates(...args: unknown[]): unknown;
  _applyReplaySafeTrackedFillAccounting(...args: unknown[]): Promise<FillAccountingResult>;
  _applyReplaySafeOrphanFillAccounting(...args: unknown[]): Promise<FillAccountingResult>;
  _buildOrphanFillFallbackKey(...args: unknown[]): unknown;
  _buildOutsideInPairGroupsForOrders(...args: unknown[]): unknown[];
  _cancelDustOrders(options?: unknown): Promise<unknown>;
  _consumeFillQueue(...args: unknown[]): Promise<unknown>;
  _createFillCallback(...args: unknown[]): unknown;
  _ensureCredentialDaemonWritable(contextLabel?: unknown): unknown;
  _executeBatchIfNeeded(rebalanceResult: unknown, contextLabel?: unknown): Promise<unknown>;
  _flushProcessedFillPersistence(...args: unknown[]): unknown;
  _flushProcessedFillPersistenceForKeys(...args: unknown[]): unknown;
  _formatUnmatchedChainOrderForLog(...args: unknown[]): unknown;
  _getGapSlotBatchSize(...args: unknown[]): unknown;
  _getMaxOpsPerBroadcast(...args: unknown[]): unknown;
  _getPipelineSignals(...args: unknown[]): unknown;
  _getPm2ProcessNames(...args: unknown[]): Promise<string[]>;
  _getRecentFillKeysSnapshot(...args: unknown[]): Record<string, number> | null;
  _handleBatchHardAbort(...args: unknown[]): unknown;
  _handlePendingTriggerReset(...args: unknown[]): unknown;
  _isCredentialDaemonError(err: unknown): unknown;
  _isNewFillKey(...args: unknown[]): unknown;
  _isOpenOrdersSyncLoopEnabled(...args: unknown[]): unknown;
  _listenForFillsHook(...args: unknown[]): unknown;
  _loadBotsConfigSnapshot(...args: unknown[]): unknown;
  _markGridActivity(...args: unknown[]): unknown;
  _performGridResync(options?: UnknownRecord): Promise<unknown>;
  _persistAndRecoverIfNeeded(...args: unknown[]): unknown;
  _processFillsWithBatching(fills: unknown, excl: unknown, contextLabel: unknown, options?: unknown): Promise<FillBatchResult>;
  _processFillsWithBootstrapMode(...args: unknown[]): unknown;
  _readOpenOrdersHook(...args: unknown[]): unknown;
  _recoverBatchSizeDrift(...args: unknown[]): unknown;
  _recoverExplicitStaleOrders(...args: unknown[]): unknown;
  _recoverFromPersistedGrid(...args: unknown[]): unknown;
  _refreshAndSyncCreditRuntime(...args: unknown[]): unknown;
  _refreshDynamicWeightDistribution(...args: unknown[]): unknown;
  _rejectCorruptedGridSnapshot(...args: unknown[]): unknown;
  _runCreditRuntimeMaintenance(context?: unknown, options?: unknown): unknown;
  _runDustHealthCheck(...args: unknown[]): unknown;
  _runGridMaintenance(context?: unknown, options?: unknown): unknown;
  _scheduleFillConsumerRestart(...args: unknown[]): unknown;
  _setupBlockchainFetchInterval(...args: unknown[]): unknown;
  _setupBotsConfigPollInterval(...args: unknown[]): unknown;
  _setupCredentialDaemonWatchdogInterval(...args: unknown[]): unknown;
  _setupCreditRuntime(...args: unknown[]): unknown;
  _setupCreditWatchdogInterval(...args: unknown[]): unknown;
  _setupDustHealthCheckInterval(...args: unknown[]): unknown;
  _setupTriggerFileDetection(...args: unknown[]): unknown;
  _startMarketAdapterPm2(...args: unknown[]): unknown;
  _startOpenOrdersSyncLoop(...args: unknown[]): unknown;
  _stopCreditWatchdogInterval(...args: unknown[]): unknown;
  _stopMarketAdapterPm2(...args: unknown[]): unknown;
  _submitCancelOrder(...args: unknown[]): unknown;
  _suspendGridPersistenceForCredentialOutage(reason: unknown): unknown;
  _resumeGridPersistenceAfterCredentialRecovery(reason: unknown): unknown;
  _syncMarketAdapterHook(...args: unknown[]): unknown;
  _syncOpenOrdersAndProcessFills(...args: unknown[]): Promise<{ aborted?: boolean; hasUnmatched?: number; syncResult?: SyncResult | null; openOrders?: unknown[] | null; [key: string]: unknown }>;
  _targetedOrderRepair(...args: unknown[]): unknown;
  _triggerStateRecoverySync(...args: unknown[]): unknown;
  _wireBroadcastRegionEndDrain(...args: unknown[]): unknown;
  _wireProcessedFillTracking(...args: unknown[]): unknown;
  _wireStructuralGridResyncRequest(...args: unknown[]): unknown;
  placeInitialOrders(...args: unknown[]): unknown;
  requestGridReset(reason?: unknown, options?: unknown): Promise<unknown>;
  shutdown(...args: unknown[]): unknown;
  updateOrdersOnChainBatch(rebalanceResult: unknown): unknown;
  updateOrdersOnChainPlan(...args: unknown[]): unknown;
}

// ============================================================
// DOMAIN: ORDER (DISCRIMINATED UNION)
// ============================================================

interface OrderBase {
  id: string;
  price: number;
  type: OrderType;
  state: OrderState;
  size: number;
  orderId: string | null;
  committedSide?: OrderType;
  rawOnChain?: { for_sale?: number | string; fetchedAt?: number } | null;
  btsFeeState?: { deferredFee?: number; [key: string]: unknown };
  metadata?: JsonObject;
  gridIndex?: number;
  idealSize?: number;
  sideHint?: string;
}

interface VirtualOrder extends OrderBase {
  state: 'virtual';
  orderId: null | '';
}

interface ActiveOrder extends OrderBase {
  state: 'active';
  orderId: string;
  size: number;
}

interface PartialOrder extends OrderBase {
  state: 'partial';
  orderId: string;
  size: number;
}

export type Order = VirtualOrder | ActiveOrder | PartialOrder;

// ============================================================
// DOMAIN: ENGINE / MANAGER CONTRACTS
// ============================================================

/** Asset metadata used by the grid engine (precision is the only required bit). */
export interface AssetInfo {
  id?: string;
  symbol?: string;
  precision: number;
  amount?: number;
  [key: string]: unknown;
}

/** The two-asset pair held by an order manager. */
export interface AssetPair {
  assetA: AssetInfo;
  assetB: AssetInfo;
  [key: string]: unknown;
}

/** Blockchain balance snapshot (nulls until the first successful fetch). */
export interface AccountTotals {
  buy: number | null;
  sell: number | null;
  buyFree: number | null;
  sellFree: number | null;
  _lastFetchedAt?: number;
  buyLocked?: number;
  sellLocked?: number;
  [key: string]: unknown;
}

/** Per-side fund amounts. */
interface SideFunds {
  buy: number;
  sell: number;
}

/** Chain/grid split of a fund category. */
interface ChainGridFunds {
  chain: SideFunds;
  grid: SideFunds;
}

/** `manager.funds` — the accountant's derived fund view. */
export interface ManagerFunds {
  available: SideFunds;
  total: ChainGridFunds;
  virtual: SideFunds;
  committed: ChainGridFunds;
  btsFeesOwed: number;
  btsBalance: { free: number; total: number; locked: number };
  allocated?: SideFunds;
  allocatedBuy?: number;
  allocatedSell?: number;
  chainFreeBuy?: number;
  chainFreeSell?: number;
  [key: string]: unknown;
}

/** `manager.persistGrid()` result — validation outcome plus skip flags. */
interface PersistGridResult extends UnknownRecord {
  isValid: boolean;
  skipped?: boolean;
  suspended?: boolean;
  reason?: string | null;
}

/** Signal raised by the manager on an illegal order state. */
export interface IllegalStateSignal extends UnknownRecord {
  context?: string;
  message?: string;
}

/** Signal raised by the manager on an accounting commitment failure. */
export interface AccountingFailureSignal extends UnknownRecord {
  side?: string;
  amount: number;
  context?: string;
  message?: string;
}

/** Result of `manager.checkFundDriftAfterFills()`. */
export interface FundDriftCheck extends UnknownRecord {
  isValid: boolean;
  driftSell?: number;
  driftBuy?: number;
  reason?: string | null;
}

/** Result of `manager.performSafeRebalance()`. */
export interface RebalanceResult extends UnknownRecord {
  aborted?: boolean;
  reason?: string | null;
  deferred?: boolean;
  actions?: unknown[];
  needsResync?: boolean;
  resyncReason?: string;
  targetGrid?: unknown;
  committed?: boolean;
}

/** Result of a chain open-orders sync pass. */
export interface SyncResult extends UnknownRecord {
  filledOrders: unknown[];
  updatedOrders: unknown[];
  ordersNeedingCorrection: unknown[];
  unmatchedChainOrders?: UnmatchedChainOrder[];
  partialFill?: boolean;
  requiresOpenOrdersSync?: boolean;
  deferred?: boolean;
  newOrders?: unknown[];
}

/** Result of a single/batch fill-history sync (`syncFromFillHistory*`). */
export interface FillHistorySyncResult extends UnknownRecord {
  deferred?: boolean;
  filledOrders?: unknown[];
  residualCancels?: unknown[];
  requiresOpenOrdersSync?: boolean;
}

/** Result of `_processFillsWithBatching` / `_processFillsWithBootstrapMode`. */
export interface FillBatchResult extends UnknownRecord {
  aborted?: boolean;
  deferred?: boolean;
}

/** Result of `manager.checkGridHealth()`. */
interface GridHealthResult extends UnknownRecord {
  buyDustOrders?: unknown[];
  sellDustOrders?: unknown[];
}

/** Runtime metrics counters. */
export interface BotMetrics extends UnknownRecord {
  fillsProcessed: number;
  batchesExecuted: number;
  fillProcessingTimeMs: number;
  lockContentionEvents: number;
  maxQueueDepth: number;
  gridLockContention: number;
  fundRecalcCount: number;
  /** Genuine post-broadcast commit refusals (working grid rejected). Excludes a poll-confirmed success that merely reuses the recovery funnel for adoption. */
  refusedCommitCount: number;
  /** Orphan fills whose proceeds were credited outside slot accounting. */
  orphanFillCreditedCount: number;
  /** BUY emissions at/above the last filled BUY pivot (guard bypass / leak). */
  restampBuyAboveAnchorCount: number;
  /** Derived boundary moved more than the active window in one plan. */
  boundaryDriftExceedsWindowCount: number;
  /** Non-spread-correction CREATE/UPDATE destinations inside the gap band (shadow). */
  gapBandPlacementShadowCount: number;
  /** Every spread-correction batch that failed to land (executed !== true), any cause. */
  spreadCorrectionRefusedCount: number;
  /** Spread-correction refusal breakdown keyed by SPREAD_CORRECTION_REFUSAL value (commit-refused, version-mismatch, create-collision, update-target-missing, unmatched-chain-orders, shutdown, batch-not-executed). */
  spreadCorrectionRefusalCauses: Record<string, number>;
  /** Bounded re-plan retries attempted after a transient spread-correction refusal. */
  spreadCorrectionRetryCount: number;
}

/** An unmatched chain order surfaced by a sync pass. */
export interface UnmatchedChainOrder extends UnknownRecord {
  chainOrderId?: string;
  orderId?: string;
  price?: number;
  size?: number;
  reason?: string;
}

/** A raw fill/operation entry carried on the incoming fill queue. */
export interface IncomingFill extends UnknownRecord {
  op?: [unknown, { order_id: string; is_maker?: boolean; pays?: { amount?: unknown; asset_id?: unknown }; receives?: { amount?: unknown; asset_id?: unknown } }];
  block_num?: number;
  id?: string;
}

/** Aggregate chain-funds summary produced by `computeChainFundTotals`. */
interface ChainFundsTotals {
  chainFreeBuy: number;
  chainFreeSell: number;
  committedChainBuy: number;
  committedChainSell: number;
  freePlusLockedBuy: number;
  freePlusLockedSell: number;
  chainTotalBuy: number;
  chainTotalSell: number;
  [key: string]: unknown;
}

/** `manager.getChainFundsSnapshot()` result. */
export interface ChainFundsSnapshot extends ChainFundsTotals {
  allocatedBuy: number;
  allocatedSell: number;
  btsBalance: { free: number; total: number; locked: number } | null;
}

/**
 * The mutable order record the grid engine operates on. Deliberately NOT the
 * discriminated `Order` union: the engine transitions a single record across
 * `virtual`/`active`/`partial` in place, so `state`/`orderId` must stay
 * independently writable.
 */
export interface ManagedOrder {
  id: string;
  price: number;
  type: OrderType;
  state: OrderState;
  size: number;
  orderId: string | null;
  committedSide?: OrderType;
  rawOnChain?: { for_sale?: number | string; fetchedAt?: number } | null;
  metadata?: UnknownRecord;
  btsFeeState?: { deferredFee?: number; deferredPaidFee?: number; [key: string]: unknown } | null;
  createUncertain?: boolean;
  gridIndex?: number;
  idealSize?: number;
  sideHint?: string;
  [key: string]: unknown;
}

/** Market-order target counts (core-order window). */
export interface CoreOrdersConfig extends UnknownRecord {
  buy?: number;
  sell?: number;
}

/** Grid-limit knobs (mirrors `GRID_LIMITS` profile overrides). */
export interface GridLimitsLike extends UnknownRecord {
  GRID_COMPARISON?: { RMS_PERCENTAGE?: number; [key: string]: unknown };
  MIN_SPREAD_ORDERS?: number;
  MIN_SPREAD_FACTOR?: number;
  MIN_ORDER_SIZE_FACTOR?: number;
  PARTIAL_DUST_THRESHOLD_PERCENTAGE?: number;
}

/** Per-side weight distribution for fund allocation. */
export interface WeightDistributionConfig extends UnknownRecord {
  buy?: number;
  sell?: number;
}

/**
 * Bot/grid configuration. Only the fields the engine reads directly are named;
 * the index signature keeps profile-defined extras reachable as `unknown`.
 */
export interface GridConfig extends UnknownRecord {
  startPrice?: number | string;
  minPrice?: number | null;
  maxPrice?: number | null;
  incrementPercent?: number;
  incrementBounds?: { MIN_PERCENT: number; MAX_PERCENT: number; [key: string]: unknown };
  targetSpreadPercent?: number;
  coreOrders?: CoreOrdersConfig;
  assetA?: string;
  assetB?: string;
  botKey?: string;
  market?: string;
  accountId?: string;
  preferredAccount?: string;
  maintenance?: { uncertainReadResyncCooldownMs?: number; [key: string]: unknown };
  min_BTS_value?: number;
  priceMode?: string;
  poolRef?: string | null;
  gridLimits?: GridLimitsLike;
  weightDistribution?: WeightDistributionConfig;
  asymmetricBounds?: UnknownRecord;
  rotation?: UnknownRecord;
  botFunds?: UnknownRecord;
  feeParams?: GridFeeParams;
  fillProcessing?: FillProcessingConfig;
  timing?: TimingConfig;
  accountTotals?: AccountTotals;
  pipelineTiming?: { TIMEOUT_MS?: number; [key: string]: unknown };
  logging?: { level?: string; config?: Record<string, unknown>; [key: string]: unknown };
}

/** Fee-schedule override block inside `config.feeParams`. */
export interface GridFeeParams extends UnknownRecord {
  MAKER_REFUND_PERCENT?: number;
  TAKER_FEE_PERCENT?: number;
  DEFAULT_MAX_FEE_RATE_PER_DAY?: number;
  BTS_ACQUIRE_THRESHOLD?: number;
  BTS_ACQUIRE_TARGET_MULTIPLIER?: number;
  BTS_RESERVATION_MULTIPLIER?: number;
  POOL_SLIPPAGE_TOLERANCE?: number;
}

/** `config.timing` knobs. */
interface TimingConfig extends UnknownRecord {
  SAFETY_NET_SYNC_TIMEOUT_MS?: number;
  CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS?: number;
  CREDIT_REBORROW_MAX_ATTEMPTS?: number;
  BLOCKCHAIN_FETCH_INTERVAL_MIN?: number;
  BOTS_CONFIG_POLL_INTERVAL_MS?: number;
  BTS_ACQUIRE_COOLDOWN_MIN?: number;
  /**
   * Spread-correction trust window (ms). How old the last completed
   * open-orders sync may be before the local snapshot is treated as stale
   * (the planner still acts but loses the LAST-FILL-GUARD bypass), and how
   * often the live market price is re-read for the crossing floor. Defaults to
   * `TIMING.SPREAD_CORRECTION_SYNC_FRESH_MS` (10 min); a non-positive value
   * disables the time bound entirely (snapshot is never stale and the live
   * price is never force-refreshed, so the floor stays on the fill anchor).
   */
  SPREAD_CORRECTION_SYNC_FRESH_MS?: number;
}

/** `config.fillProcessing` knobs read by the fill consumer. */
interface FillProcessingConfig extends UnknownRecord {
  CONSUMER_BACKOFF_INITIAL_MS?: number;
  CONSUMER_BACKOFF_MAX_MS?: number;
  MAX_CONSECUTIVE_CONSUMER_FAILURES?: number;
  OPERATION_TYPE?: number;
}

/** Async mutex surface (AsyncLock) used by the manager. */
export interface ManagerLock {
  acquire<T>(fn: () => T | Promise<T>, options?: number | { timeout?: number }): Promise<T>;
  isReentrant(): boolean;
  isLocked(): boolean;
  forceRelease(reason?: string): unknown;
  getQueueLength(): number;
  heldForMs(): number;
}

/** `refreshAccountTotalsIfStale()` freshness gate. */
interface AccountTotalsGate {
  ok: boolean;
  [key: string]: unknown;
}

/** Accountant surface the sync engine calls directly. */
/** Result of `accountant.processFillAccounting()`. */
interface FillAccountingResult extends UnknownRecord {
  status: string;
}

interface AccountantLike {
  processFillAccounting(fillOp: unknown, fillKey: string, options?: UnknownRecord): Promise<boolean>;
  adjustTotalBalance(orderType: string, delta: number, operation: string): Promise<unknown>;
  addToChainFree(orderType: string, size: number, operation: string): Promise<unknown>;
  _performStateRecovery(...args: unknown[]): { isValid: boolean; reason?: string | null; [key: string]: unknown } | Promise<{ isValid: boolean; reason?: string | null; [key: string]: unknown }>;
  updateOptimisticFreeBalance(...args: unknown[]): Promise<unknown>;
  recalculateFunds(): Promise<unknown>;
  resetFunds(): unknown;
  _getBtsOrderType?(): string | null;
  resetRecoveryState?(): unknown;
}

/** A pending price-correction queue entry. */
export interface PendingPriceCorrection extends UnknownRecord {
  chainOrderId?: string;
  isSurplus?: boolean;
  cancelOnly?: boolean;
  gapEvacuation?: boolean;
  queuedBy?: string;
  queuedAt?: number;
  reason?: string;
  gridOrder?: ManagedOrder | null;
}

/** A startup Phase-1 cancel plan executed in Phase 2. */
export interface StartupCancelPlan {
  chainOrderId: string;
  chainOrderObj: ChainOrder | ManagedOrder | null;
  releaseUntrackedFunds?: boolean;
  orderType?: OrderType;
  boundaryIdx?: number | null;
  gapSlots?: number;
  gridOrderId?: string;
  gridOrder?: ManagedOrder;
}

/** A startup Phase-1 update plan executed in Phase 2. */
export interface StartupUpdatePlan {
  orderType: OrderType;
  chainOrderId: string;
  chainOrderObj: ChainOrder;
  gridOrderId: string;
  gridOrder: ManagedOrder;
}

/** A startup Phase-1 create plan executed in Phase 2. */
export interface StartupCreatePlan {
  orderType: OrderType;
  gridOrder: ManagedOrder;
  orderLabel?: string;
  recovery?: { triggerMessage: string; source: string };
  extraOptions?: UnknownRecord;
}

/** A validation error/warning emitted by `validateOrder()`. */
export interface ValidationIssue {
  code: string;
  message: string;
  isFatal?: boolean;
  autoCorrect?: UnknownRecord;
  [key: string]: unknown;
}

/** A per-asset fund shortfall emitted by `validateWorkingGridFunds()`. */
export interface FundShortfall {
  asset: string;
  required: number;
  available: number;
  deficit: number;
}

/**
 * A copy-on-write reconcile action (`reconcileGrid` / the COW executor).
 * `type` is one of the `COW_ACTIONS` values; the remaining fields are populated
 * per action kind (CREATE carries `order`, CANCEL carries `orderId`+`reason`,
 * UPDATE carries `newGridId`/`newSize`/`newPrice`/`isRotation`).
 */
export interface CowAction {
  type: string;
  id: string;
  orderId?: string | null;
  reason?: string;
  order?: ManagedOrder;
  newGridId?: string;
  newSize?: number;
  newPrice?: number;
  isRotation?: boolean;
  origin?: string;
  evacBoundary?: number;
  evacGapSlots?: number;
  [key: string]: unknown;
}

/** A CREATE-target violation from `validateCreateTargetSlots()`. */
export interface CreateTargetViolation {
  targetId: string;
  currentOrderId?: string | null;
  currentType?: string;
  currentState?: string;
  reason: string;
  duplicateOf?: string;
  [key: string]: unknown;
}

/** Asset precisions used by the fund validators (per side). */
export interface FundPrecisions {
  buyPrecision?: number;
  sellPrecision?: number;
}

/** Optimistic/projected fund figures consumed by `validateWorkingGridFunds()`. */
export interface ProjectedFunds {
  allocatedBuy?: number;
  allocatedSell?: number;
  chainTotalBuy?: number;
  chainTotalSell?: number;
  freeBuy?: number;
  freeSell?: number;
  chainFreeBuy?: number;
  chainFreeSell?: number;
  btsBalance?: { free?: number; total?: number; locked?: number } | null;
  [key: string]: unknown;
}

/** A queued broadcast-region entry. */
export interface PendingBroadcast {
  slotId?: string;
  order?: ManagedOrder | null;
  [key: string]: unknown;
}

/** Account-orders adapter surface the engine calls directly. */
export interface AccountOrdersLike {
  syncMeta(botConfig: unknown): Promise<unknown>;
  storeMasterGrid(...args: unknown[]): Promise<unknown>;
  loadGrid(forceReload?: boolean): unknown[] | null;
  loadBoundaryIdx(forceReload?: boolean): number | null;
  loadGenesis(forceReload?: boolean): unknown;
  loadGapEvacStreaks(forceReload?: boolean): unknown;
  loadLastFillPivot?(forceReload?: boolean): unknown;
  loadLastMarketFill?(forceReload?: boolean): unknown;
  loadPendingFillCrawls(forceReload?: boolean): unknown[];
  loadRecentFillKeys(forceReload?: boolean): unknown;
  loadPersistedAssets(forceReload?: boolean): { assetA?: AssetInfo; assetB?: AssetInfo } | null;
  loadBtsBalance(forceReload?: boolean): unknown;
  loadBtsFeesOwed(forceReload?: boolean): unknown;
  clearGrid(): Promise<unknown>;
  clearPersistedBoundary(...args: unknown[]): Promise<unknown>;
  clearPersistedLastFillPivot(...args: unknown[]): Promise<unknown>;
  clearPersistedLastMarketFill?(...args: unknown[]): Promise<unknown>;
  backupSnapshot?(reason?: string): Promise<string | null>;
  loadProcessedFills(options?: boolean | { forceReload?: boolean; minTimestamp?: number | null }): Map<string, number>;
  updateProcessedFillsBatch(fills: Map<string, number>): Promise<unknown>;
  cleanOldProcessedFills(olderThanMs?: number): Promise<unknown>;
  getAssetBalances?(forceReload?: boolean): unknown;
}

/** Batch-persistence handle for processed fill keys. */
export interface ProcessedFillStoreLike {
  configure(options?: { accountOrders?: AccountOrdersLike | null }): void;
  setShuttingDown(value: boolean): void;
  loadPersisted(options?: { forceReload?: boolean; minTimestamp?: number | null }): number;
  mergeTracker(sourceTracker: Map<string, number>): void;
  persist(fillKey: string, timestamp: number, options?: { mode?: string }): Promise<void>;
  discard(fillKey: string, timestamp?: number): void;
  flush(reason?: string, options?: { throwOnError?: boolean }): Promise<void>;
  flushKeys(fillKeys: string[] | Set<string>, reason?: string, options?: { throwOnError?: boolean }): Promise<void>;
  [key: string]: unknown;
}

/** The manager's logger surface (all levels are present on `Logger`). */
export interface ManagerLogger {
  log: LogFn;
  warn: LogFn;
  info: LogFn;
  debug: LogFn;
  error: LogFn;
  level?: string;
  marketName?: unknown;
  logFundsStatus(manager: unknown, context?: string, forceDetailed?: boolean): void;
  logOrderGrid?(orders: ManagedOrder[], startPrice: number): void;
  flush?(): Promise<void>;
}

/** Mutable recovery-state record (all fields optional to allow partial writes). */
interface ManagerRecoveryState {
  phase?: string;
  attemptCount?: number;
  lastAttemptAt?: number;
  inFlight?: boolean;
  lastFailureAt?: number;
  structuralResyncRequested?: boolean;
  [key: string]: unknown;
}

/**
 * The contract the order engine consumes from `OrderManager`. This is the
 * decoupled interface the `modules/order/**` layer types its `manager`
 * parameters against, so the engine does not need to import the concrete
 * class (avoiding a runtime import cycle). `OrderManager` structurally
 * satisfies it.
 *
 * Optional members are either wired in later by the runtime layer
 * (e.g. `requestStructuralGridResync`, `notifyBoundaryUpdate`) or read only
 * defensively; keep them optional so partial test doubles still type-check.
 */
/** Minimal surface of the credit runtime consumed by the bot/manager layer. */
export interface CreditRuntimeLike {
  config: GridConfig;
  loadState(): Promise<unknown>;
  refreshState(): Promise<unknown>;
  runMaintenance(context?: unknown, options?: unknown): Promise<unknown>;
  runCreditWatchdog(): Promise<unknown>;
  shutdown(): Promise<unknown>;
}

export interface OrderManagerLike {
  _consecutiveBoundaryHolds?: number;
  /**
   * Set by the spread-correction planner when the corrected side's rail reserves
   * more than the chain free balance (virtual > free). Cleared when a correction
   * becomes fundable again. The out-of-spread watchdog escalates on its short
   * fund window when this is fresh.
   */
  _spreadRailOversubscribed?: { side: string; virtual: number; free: number; at: number } | null;
  _boundaryShiftBudgetBase?: number;
  _lastBoundaryHoldInfo?: unknown;
  _lastHeldPlanSignature?: { boundaryIdx?: number | null; pivot?: number | null; fillsAt?: number | null; [key: string]: unknown } | null;
  // --- configuration & identity ---
  config: GridConfig;
  marketName: string | null;
  logger: ManagerLogger;
  accountId: string | null;
  account?: unknown;
  accountant: AccountantLike;
  strategy?: unknown;
  sync?: unknown;

  // --- grid state ---
  orders: Map<string, ManagedOrder>;
  assets: AssetPair;
  funds: ManagerFunds;
  accountTotals: AccountTotals;
  accountOrders: AccountOrdersLike;
  flushGridDirty(contextLabel?: string): Promise<unknown>;
  recordLastFilledPrices(fills: unknown[]): void;
  suspendGridPersistence(reason?: string): unknown;
  resumeGridPersistence(reason?: string | null): unknown;
  boundaryIdx: number | null;
  _deferredRebalanceAt?: number;
  _onBroadcastRegionEndListeners?: Array<() => void>;
  targetGrid?: unknown;
  initialSpreadCount: number;
  currentSpreadCount: number;
  outOfSpread: number;
  btsBalance?: { free: number; total: number; locked: number };
  ordersNeedingPriceCorrection: PendingPriceCorrection[];
  _gapSlots: number;
  _gridVersion: number;
  _gridLock: ManagerLock;
  _fundLock: ManagerLock;
  _accountTotalsPromise: Promise<unknown> | null;
  accountTotalsStale: boolean;
  _placedAt: Map<string, number>;
  _orderIdAssignedAt: Map<string, number>;
  _pendingBroadcasts: Map<string, PendingBroadcast>;
  _pendingFillCrawls: Array<{ slotId: string; side: string; ts: number }>;
  _recentFillKeysSnapshot: Record<string, number> | null;
  _gridSidesUpdated: Set<string>;
  shadowOrderIds: Map<string, number>;
  processedFillTracker: Map<string, number>;
  processedFillStore: ProcessedFillStoreLike | null;
  _pauseFundRecalc: number;
  _pauseRecalcLogging: boolean;
  _throwOnIllegalState: boolean;
  _fillBatchInFlight: number;
  _fillProcessingLock: ManagerLock;
  _syncLock: ManagerLock;
  _divergenceLock: ManagerLock;
  _resetLastFillPivot?(reason?: string): boolean;
  _rateLimitStaleTotalsWarn(kind: string): boolean;
  clearStalePipelineOperations(): void;
  isPipelineEmpty(...args: unknown[]): { isEmpty: boolean; reasons: string[] };
  _cleanExpiredLocks(): void;
  getActiveShadowLockCount(): number;
  _clearStaleBroadcastFlag(): void;
  _orphanFillsCreditedAt?: number | null;
  _broadcastingStartedAt: number;
  _recoveryState: ManagerRecoveryState;
  _committedOrderIdsBuiltAt?: number;
  _committedOrderIds?: Set<string>;
  _recoveryAttempted?: boolean;
  _gapEvacStreaks: Map<string, number>;
  _gapEvacCancelQueued?: Set<string>;
  _genesis?: { startPrice?: number; incrementPercent?: number; gapSlots?: number; priceLevels?: readonly unknown[]; priceLevelsHash?: string; createdAt?: number } | null;
  _missingGenesis?: unknown;
  _metrics?: BotMetrics;
  _lastBoundaryDriftWarnAt?: number;
  _genesisInvariantViolations?: number;
  _genesisInvariantLoggedAt?: number;
  _fundDriftLedger?: { side: string; direction: string; count: number; firstAt: number; lastAt: number } | null;
  _lastFilledBuyPrice: number | null;
  _lastFilledSellPrice: number | null;
  _lastFilledPrice: number | null;
  _lastFilledType: string | null;
  _lastFilledAt: number | null;
  lastFillPivotSource: 'fill' | 'book' | null;
  // Bot-scoped last-market-fill reference (survives grid regeneration).
  _lastMarketFillPrice?: number | null;
  _lastMarketFillType?: string | null;
  _lastMarketFillAt?: number | null;
  // Externally-observed live market price (B/A) and its read/attempt clocks.
  _liveMarketPrice?: number | null;
  _liveMarketPriceAt?: number | null;
  _liveMarketPriceAttemptedAt?: number | null;
  _lastSyncAt?: number;

  // --- internals the runtime wires in or the engine reads defensively ---
  _lastUnmatchedChainOrders?: UnmatchedChainOrder[];
  _lastUnmatchedChainOrdersAt?: number;
  _lastAccountingFailure?: unknown;
  _pendingRecovery: Promise<unknown> | null;
  _lastGridPricingContext?: {
    gridPrice?: unknown;
    gridPriceOffsetPct?: unknown;
    offsetAdjustedStartPrice?: unknown;
    startPrice?: unknown;
    configuredMinPrice?: unknown;
    configuredMaxPrice?: unknown;
    rangeScalingFactor?: unknown;
    [key: string]: unknown;
  } | null;
  _boundaryShiftBudget?: unknown;
  _persistenceWarning?: unknown;
  _recoveryExhaustedAt?: number | null;
  _skipEmptyReadConfirmDelay?: unknown;
  _readSingleOrderFn?: unknown;
  _batchReadOrdersFn?: unknown;
  _confirmEmptyReadFn?: unknown;
  _syncGeneration?: number;
  _suspectEmptyReads?: { count: number; firstAt: number };
  _correctionQueueWarnAt?: number;
  _gridBloatDetectedAt?: number;

  // --- lifecycle / rebalance state ---
  isRebalancing(): boolean;
  isBootstrapping(): boolean;
  isBroadcastingActive(): boolean;
  isPlanningActive(): boolean;
  setShuttingDown(value: boolean): void;
  startBootstrap(): void;
  finishBootstrap(): void;
  startBroadcasting(): void;
  stopBroadcasting(): void;
  addBroadcastRegionEndListener(listener: () => void): void;
  _applySync(data: unknown, src: string): Promise<unknown>;
  synchronizeWithChain(data: unknown, src: string): Promise<SyncResult>;
  requestStructuralGridResync?: (reason?: string, details?: UnknownRecord) => Promise<{ skipped?: boolean; reason?: string; [key: string]: unknown } | undefined>;
  validateGridStateForPersistence(options?: { allowBootstrapTransient?: boolean; [key: string]: unknown }): { isValid: boolean; [key: string]: unknown };
  notifyBoundaryUpdate?: (boundaryIdx: number | null) => unknown;

  // --- funds ---
  resetFunds(): Promise<void>;
  recalculateFunds(): Promise<void>;
  applyBotFundsAllocation(): void;
  setAccountTotals(totals?: Partial<AccountTotals>): Promise<unknown>;
  refreshAccountTotalsIfStale(options?: { force?: boolean }): Promise<AccountTotalsGate>;
  reanchorAccountTotals(label?: string): Promise<unknown>;
  lockOrders(orderIds: unknown): void;
  unlockOrders(orderIds: unknown): void;
  pauseFundRecalc(): void;
  resumeFundRecalc(): Promise<void>;
  pauseRecalcLogging(): void;
  resumeRecalcLogging(): void;
  fetchAccountTotals(accountId?: string | null): Promise<void>;
  waitForAccountTotals(timeoutMs?: number): Promise<void>;
  getChainFundsSnapshot(): ChainFundsSnapshot;
  _initializeAssets(): Promise<unknown>;

  // --- orders & grid mutation ---
  _updateOrder(order: ManagedOrder, context?: string, options?: UnknownRecord): Promise<boolean>;
  _applyOrderUpdate(order: ManagedOrder, context?: string, options?: UnknownRecord): Promise<boolean>;
  applyGridUpdateBatch(updates: unknown, context?: string, options?: UnknownRecord): Promise<boolean>;
  getOrdersByTypeAndState(type?: OrderType | null, state?: OrderState): ManagedOrder[];
  _markGridDirty(): void;
  _restoreBoundary(newIdx: number | null): void;
  _clearPendingFillCrawls(reason?: string): void;
  syncFromOpenOrders(orders: unknown, info?: unknown): Promise<SyncResult>;
  syncFromFillHistory(fill: unknown, options?: UnknownRecord): Promise<FillHistorySyncResult>;
  syncFromFillHistoryBatch(fills: unknown, options?: UnknownRecord): Promise<FillHistorySyncResult>;
  checkSpreadCondition(...args: unknown[]): Promise<{ ordersPlaced?: number; partialsMoved?: number; stall?: SpreadCorrectionStall; [key: string]: unknown }>;
  _fetchAccountBalancesAndSetTotals(...args: unknown[]): Promise<unknown>;
  getInitialOrdersToActivate(): ManagedOrder[];
  seedLastFilledPricesFromBook(...args: unknown[]): void;
  checkGridHealth(...args: unknown[]): Promise<GridHealthResult>;
  processFilledOrders(orders: unknown, excl: unknown, options?: UnknownRecord): Promise<unknown>;
  performSafeRebalance(fills?: unknown, excludeIds?: Set<string>, options?: UnknownRecord): Promise<RebalanceResult>;
  consumeIllegalStateSignal(): IllegalStateSignal | null;
  consumeAccountingFailureSignal(): AccountingFailureSignal | null;
  checkFundDriftAfterFills(...args: unknown[]): FundDriftCheck;
  _popWorkingGridRef?(result?: unknown): void;
  _pushWorkingGridRef(...args: unknown[]): unknown;
  _resetRebalanceStateToDepth(...args: unknown[]): void;
  _setRebalanceState(...args: unknown[]): void;
  _lastBoundaryHoldResyncAt: number;
  _commitWorkingGrid(workingGrid: unknown, workingIndexes: unknown, workingBoundary: unknown, options?: UnknownRecord): Promise<boolean>;
  persistGrid(snapshotOrders?: unknown, recentFillKeys?: unknown, fundSnapshot?: { btsFeesOwed: number; accountTotals: AccountTotals }): Promise<PersistGridResult>;
  calculateCurrentSpread(): number;
}
