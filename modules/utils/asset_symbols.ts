/**
 * Central asset-symbol / asset-ref normalization.
 *
 * BitShares stores asset symbols canonically UPPERCASE, so the assetA and
 * assetB symbols of a bot pair are always UPPERCASE on chain.
 * The chain's asset lookups (`get_assets` / `lookup_asset_symbols`) are
 * case-sensitive: a lowercase symbol resolves to null (not an error), so a
 * lowercase input silently drops the asset. Casing
 * also leaks into everything built from a resolved symbol: the `symbol` field
 * we attach to assets, chart titles, cache-file names, Kibana query terms, and
 * strict in-process comparisons such as `assetA === 'CORE'`. That is a
 * silent-wrong-answer class of bug, not a loud
 * one, so the conversion is done ONCE here and applied at every boundary that
 * accepts a pair from a human (CLI prompts, `dexbot tv`/`dw` targets) or hands
 * a symbol to the chain (`lookup_asset_symbols`).
 *
 * Rules:
 *   - Asset OBJECT IDs ("1.3.x") are not symbols: they are returned verbatim so
 *     ref-routing callers (get_assets vs lookup_asset_symbols) keep working.
 *   - Everything else is trimmed and uppercased.
 *   - Non-strings / empty input normalize to '' (never "undefined"/"null").
 *
 * Browser-safe: no node built-ins.
 */

import type { UnknownRecord } from '../types.js';
import { isUnknownRecord } from '../types.js';

/** BitShares asset object id, e.g. "1.3.0" (the core asset) or "1.3.529". */
const ASSET_OBJECT_ID_PATTERN = /^1\.3\.\d+$/;

/** True when the value is a BitShares asset object id, not a symbol. */
export function isAssetObjectId(value: unknown): boolean {
  return ASSET_OBJECT_ID_PATTERN.test(String(value ?? '').trim());
}

/**
 * Canonicalize an asset symbol (or pass an asset object id through untouched).
 * This is the single conversion used before a symbol reaches the blockchain
 * and before it is compared, cached, or rendered.
 */
export function normalizeAssetSymbol(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  if (!text) return '';
  if (ASSET_OBJECT_ID_PATTERN.test(text)) return text;
  return text.toUpperCase();
}

/**
 * Same as {@link normalizeAssetSymbol}; reads better at call sites that pass a
 * mixed "id or symbol" reference (credit runtime, credential policy, pools).
 */
export function normalizeAssetRef(value: unknown): string {
  return normalizeAssetSymbol(value);
}

/**
 * Both spellings of a human-typed asset reference: the reference as typed
 * (trimmed) and its canonical UPPERCASE form. Resolvers query the canonical form
 * first and retry the as-typed spelling only when that misses (see
 * modules/asset_lookup.ts), because `get_assets` is case-sensitive and a node
 * may still hold a non-canonical symbol. Object ids collapse to one entry.
 *
 * @returns [] for empty input, otherwise 1-2 distinct spellings.
 */
export function assetSymbolCandidates(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const typed = String(value).trim();
  if (!typed) return [];
  const canonical = normalizeAssetSymbol(typed);
  return typed === canonical ? [canonical] : [typed, canonical];
}

/** Case- and whitespace-insensitive asset-symbol equality. */
export function isSameAssetSymbol(a: unknown, b: unknown): boolean {
  const na = normalizeAssetSymbol(a);
  const nb = normalizeAssetSymbol(b);
  return na !== '' && na === nb;
}

/**
 * Split an "assetA/assetB" CLI target into the two normalized symbols.
 * Whitespace around either leg is dropped and both legs are uppercased, so
 * "assetb/asseta" and "ASSETB / ASSETA" produce the same assetA/assetB pair.
 * @returns exactly two symbols, or [] when the target is not a usable pair.
 */
export function splitPairTarget(target: unknown): string[] {
  return String(target ?? '')
    .split('/')
    .map((part) => normalizeAssetSymbol(part))
    .filter((part) => part !== '');
}

// ── Config-level canonicalization (the one place that knows the key names) ────

/** bots.json keys holding an asset SYMBOL at the top level of a bot entry. */
const BOT_ASSET_SYMBOL_KEYS = ['assetA', 'assetB'];

/** `debtPolicy.lending[]` keys holding an asset SYMBOL. */
const LENDING_ASSET_SYMBOL_KEYS = ['asset', 'collateralAsset'];

/**
 * Canonicalize the asset symbols of a bot config entry, recursively into
 * `debtPolicy.lending[]`. This is the single definition of WHICH config keys
 * hold symbols, shared by every config reader:
 *   - `modules/bot_settings.normalizeBotEntry` (production read funnel)
 *   - `analysis/bot_key_utils.loadBotMeta` (analysis/tools read funnel)
 *
 * Returns the SAME reference when there is nothing to canonicalize, so the
 * common already-uppercase case costs one pass and no allocation, and a
 * hand-edited lowercase entry never leaks into a chain call, a comparison or
 * a rendered label. The input is never mutated.
 */
export function canonicalizeBotAssetSymbols<T extends UnknownRecord>(entry: T): T {
  if (!entry || typeof entry !== 'object') return entry;

  let changed = false;
  const out: UnknownRecord = { ...entry };
  for (const key of BOT_ASSET_SYMBOL_KEYS) {
    if (typeof out[key] === 'string') {
      const canonical = normalizeAssetSymbol(out[key]);
      if (canonical !== out[key]) {
        out[key] = canonical;
        changed = true;
      }
    }
  }

  if ('debtPolicy' in out) {
    const policy = out.debtPolicy;
    if (isUnknownRecord(policy) && Array.isArray(policy.lending)) {
      let lendingChanged = false;
      const lending = policy.lending.map((item: unknown) => {
        if (!item || typeof item !== 'object') return item;
        const canonicalItem: UnknownRecord = { ...item };
        for (const key of LENDING_ASSET_SYMBOL_KEYS) {
          if (typeof canonicalItem[key] === 'string') {
            const canonical = normalizeAssetSymbol(canonicalItem[key]);
            if (canonical !== canonicalItem[key]) {
              canonicalItem[key] = canonical;
              lendingChanged = true;
            }
          }
        }
        return canonicalItem;
      });
      if (lendingChanged) {
        out.debtPolicy = { ...policy, lending };
        changed = true;
      }
    }
  }

  return (changed ? out : entry) as T;
}
