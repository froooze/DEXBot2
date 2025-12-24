# Changelog

All notable changes to this project will be documented in this file.

## [0.4.2] - 2025-12-24 - Comment & Documentation Fixes

### Fixed
- **BTS Fee Formula Documentation**: Updated outdated comments and logged output to accurately reflect the complete fee calculation formula
  - Fixed `modules/order/grid.js`: Changed comment from "2x multiplier" to "4x multiplier" to match actual implementation
  - Updated formula in 5 files to show complete formula: `available = max(0, chainFree - virtuel - cacheFunds - applicableBtsFeesOwed - btsFeesReservation)`
  - Fixed `modules/order/logger.js`: Console output now displays full formula instead of simplified version
  - Updated `modules/order/manager.js`: Changed variable name references from ambiguous "4xReservation" to proper "btsFeesReservation"
  - Fixed `modules/account_bots.js`: Comment now correctly states default targetSpreadPercent is 4x not 3x
  - **Note**: All function implementations were already correct; this release only updates documentation to match the actual calculations

---

## [0.4.1] - 2025-12-23 - Order Consolidation, Grid Edge Handling & Partial Order Fixes

### Features
- **Code Consolidation**: Eliminated ~1,000 lines of duplicate code across entry points
  - Extracted shared `DEXBot` class to `modules/dexbot_class.js` (822 lines)
  - bot.js refactored from 1,021 → 186 lines
  - dexbot.js refactored from 1,568 → 598 lines
  - Unified class-based approach with logPrefix options for context-specific behavior
  - Extracted `buildCreateOrderArgs()` utility to `modules/order/utils.js`

- **Conditional Rotation**: Smart order creation at grid boundaries
  - When active order count drops below target, creates new orders instead of rotating
  - Handles grid edge cases where fewer orders can be placed near min/max prices
  - Seamlessly transitions back to normal rotation when target is reached
  - Prevents perpetual deficit caused by edge boundary constraints
  - Comprehensive test coverage with edge case validation

- **Repository Statistics Analyzer**: Interactive git history visualization
  - Analyzes repository commits and generates beautiful HTML charts
  - Tracks added/deleted lines across codebase with daily granularity
  - Charts include daily changes and cumulative statistics
  - Configurable file pattern filtering for focused analysis
  - Script: `scripts/analyze-repo-stats.js`

### Fixed
- **Partial Order State Machine Invariant**: Guaranteed PARTIAL orders always have size > 0
  - Fixed bug in `synchronizeWithChain()` where PARTIAL could be set with size = 0
  - Proper state transitions: ACTIVE (size > 0) → PARTIAL (size > 0) → SPREAD (size = 0)
  - PARTIAL and SPREAD orders excluded from divergence calculations
  - Prevents invalid order states from persisting to storage

### Changed
- **Entry Point Architecture**: Simplified bot.js and dexbot.js to thin wrappers
  - Removed duplicate class definitions
  - All core logic now centralized in `modules/dexbot_class.js`
  - Reduces maintenance overhead and improves consistency
  - Options object pattern enables context-specific behavior (e.g., logPrefix)

### Testing
- Added comprehensive test suite for conditional rotation edge cases
- Added state machine validation tests for partial orders
- All tests passing with improved grid coverage scenarios

### Technical Details
- **Grid Coverage Recovery**: Gradual recovery mechanism for edge-bound grids
  - Shortage = `targetCount - currentActiveCount`
  - Creates `min(shortage, fillCount)` new orders per fill cycle
  - Continues until target is reached, then resumes rotation
  - Respects available virtual orders (no over-activation)

- **Code Quality**: Significant reduction in complexity and duplication
  - Common patterns unified in shared class
  - Easier to maintain and update core logic
  - Improved testability with centralized implementation

---

## [0.4.0] - 2025-12-22 - Fund Management Consolidation & Automatic Fund Cycling

### Features
- **Automatic Fund Cycling**: Available funds now automatically included in cacheFunds before rotation
  - Newly deposited funds immediately available for grid sizing
  - Grid resizes when deposits arrive, not just after fills
  - More responsive to market changes and new capital inflows

- **Unified Fund Management**: Complete consolidation of pendingProceeds into cacheFunds
  - Simplified fund tracking: single cacheFunds field for all unallocated funds
  - Cleaner codebase (272 line reduction in complexity)
  - Backward compatible: legacy pendingProceeds automatically migrated

### Changed
- **BREAKING CHANGE**: `pendingProceeds` field removed from storage schema
  - Affects: `profiles/orders/<bot-name>.json` files for existing bots
  - Migration: Use `scripts/migrate_pending_proceeds.js` before first startup with v0.4.0
  - Backward compat: Legacy pendingProceeds merged into cacheFunds on load

- **Fund Formula Updated**:
  ```
  OLD: available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed) + pendingProceeds
  NEW: available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed)
  ```

- **Grid Regeneration Threshold**: Now includes available funds
  - OLD: Checked only `cacheFunds / gridAllocation`
  - NEW: Checks `(cacheFunds + availableFunds) / gridAllocation`
  - Result: Grid resizes when deposits arrive, enabling fund cycling

- **Fee Deduction**: Now deducts BTS fees from cacheFunds instead of pendingProceeds
  - Called once per rotation cycle after all proceeds added
  - Cleaner integration with fund cycling

### Fixed
- **Partial Order Precision**: Fixed floating-point noise in partial fill detection
  - Now uses integer-based subtraction (blockchain-safe precision)
  - Converts orders to blockchain units, subtracts, converts back
  - Prevents false PARTIAL states from float arithmetic errors (e.g., 1e-18 floats)

- **Logger Undefined Variables**: Fixed references to removed pendingProceeds variables
  - Removed orphaned variable definitions
  - Cleaned up fund display logic in logFundsStatus()

- **Bot Metadata Initialization**: Fixed new order files being created with null metadata
  - Ensured `ensureBotEntries()` is called before any Grid initialization
  - Prevents order files from having null values for name, assetA, assetB
  - Metadata properly initialized from bot configuration in profiles/bots.json at startup
  - Applied fix to both bot.js and dexbot.js DEXBot classes

### Migration Guide
1. **Backup** your `profiles/orders/` directory before updating
2. **Run migration** (if you have existing bots with pendingProceeds):
   ```bash
   node scripts/migrate_pending_proceeds.js
   ```
3. **Restart bots**: Legacy data automatically merged into cacheFunds on load
   - No data loss - all proceeds preserved
   - Grid sizing adjusted automatically

### Technical Details
- **Fund Consolidation**: All proceeds and surpluses now consolidated in single cacheFunds field
- **Backward Compatibility**: Automatic merge of legacy pendingProceeds into cacheFunds during grid load
- **Storage**: Updated account_orders.js schema, removed pendingProceeds persistence methods
- **Test Coverage**: Added test_fund_cycling_trigger.js, test_crossed_rotation.js, test_fee_refinement.js

---

## [0.3.0] - 2025-12-19 - Grid Divergence Detection & Percentage-Based Thresholds

### Features
- **Grid Divergence Detection System**: Intelligent grid state monitoring and automatic regeneration
  - Quadratic error metric calculates divergence between in-memory and persisted grids: Σ((calculated - persisted) / persisted)² / count
  - Automatic grid size recalculation when divergence exceeds DIVERGENCE_THRESHOLD_PERCENTAGE (default: 1%)
  - Detects when cached fund reserves exceed configured percentage threshold (default: 3%)
  - Two independent triggering mechanisms ensure grid stays synchronized with actual blockchain orders

- **Percentage-Based Threshold System**: Standardized threshold configuration across the system
  - Replaced promille-based thresholds (0-1000 scale) with percentage-based (0-100 scale)
  - More intuitive configuration and easier to understand threshold values
  - DIVERGENCE_THRESHOLD_PERCENTAGE: Controls grid divergence detection sensitivity
  - GRID_REGENERATION_PERCENTAGE: Controls when cached funds trigger grid recalculation (default: 3%)

- **Enhanced Documentation**: Comprehensive threshold documentation with distribution analysis
  - Added Root Mean Square (RMS) explanation and threshold reference tables
  - Distribution analysis showing how threshold requirements change with error distribution patterns
  - Clear explanation of how same average error (e.g., 3.2%) requires different thresholds based on distribution
  - Migration guide for percentage-based thresholds
  - Mathematical formulas for threshold calculation and grid regeneration logic

### Changed
- **Breaking Change**: DIVERGENCE_THRESHOLD_Promille renamed to DIVERGENCE_THRESHOLD_PERCENTAGE
  - Configuration files using old name must be updated
  - Old: promille values (10 promille ≈ 1% divergence)
  - New: percentage values (1 = 1% divergence threshold)
  - Update pattern: divide old promille value by 10 to get new percentage value

- **Default Threshold Changes**: Improved defaults based on real-world testing
  - GRID_REGENERATION_PERCENTAGE: 1% → 3% (more stable, reduces unnecessary regeneration)
  - DIVERGENCE_THRESHOLD_PERCENTAGE: 10 promille → 1% (more sensitive divergence detection)

- **Grid Comparison Metrics**: Enhanced logging and comparison output
  - All threshold comparisons now use percentage-based values
  - Log output displays percentage divergence instead of promille
  - Clearer threshold comparison messages in grid update logging

### Fixed
- **Threshold Comparison Logic**: Corrected grid comparison triggering mechanism
  - Changed division from /1000 (promille) to /100 (percentage) in threshold calculations
  - Applied fixes to both BUY and SELL side grid regeneration logic (grid.js lines 1038-1040, 1063-1065)
  - Ensures accurate divergence detection and grid synchronization

### Technical Details
- **Quadratic Error Metric**: Sum of squared relative differences detects concentrated outliers
  - Formula: Σ((calculated - persisted) / persisted)² / count
  - Penalizes outliers more than simple average, reflects actual grid synchronization issues
  - RMS (Root Mean Square) = √(metric), provides alternative view of error magnitude

- **Distribution Scaling**: Threshold requirements scale with distribution evenness
  - Theoretical relationship: promille ≈ 1 + n (where n = ratio of perfect orders)
  - Example: 10% outlier distribution (n=9) requires ~10× higher threshold than 100% even distribution
  - Reference table in README documents thresholds for 1%→10% average errors across distributions

- **Grid Regeneration Mechanics**: Independent triggering mechanisms
  - Mechanism 1: Cache funds accumulating to GRID_REGENERATION_PERCENTAGE (3%) triggers recalculation
  - Mechanism 2: Grid divergence exceeding DIVERGENCE_THRESHOLD_PERCENTAGE (1%) triggers update
  - Both operate independently, ensuring grid stays synchronized with actual blockchain state

### Migration Guide
If upgrading from v0.2.0:
1. Update configuration files to use DIVERGENCE_THRESHOLD_PERCENTAGE instead of DIVERGENCE_THRESHOLD_Promille
2. Convert threshold values: new_value = old_promille_value / 10
   - Old: 10 promille → New: 1%
   - Old: 100 promille → New: 10%
3. Test with dryRun: true to verify threshold behavior matches expectations
4. Default GRID_REGENERATION_PERCENTAGE (3%) is now more conservative; adjust if needed

### Testing
- Comprehensive test coverage for grid divergence detection (test_grid_comparison.js)
- Validates quadratic error metric calculations across various distribution patterns
- Tests both cache funds and divergence triggers independently and in combination
- Percentage-based threshold comparisons verified across BUY and SELL sides

## [0.2.0] - 2025-12-12 - Startup Grid Reconciliation & Fee Caching System

### Features
- **Startup Grid Reconciliation System**: Intelligent grid recovery at startup
  - Price-based matching to resume persisted grids with existing on-chain orders
  - Smart regeneration decisions based on on-chain order states
  - Count-based reconciliation for order synchronization
  - Unified startup logic in both bot.js and dexbot.js

- **Fee Caching System**: Improved fill processing performance
  - One-time fee data loading to avoid repeated blockchain queries
  - Cache fee deductions throughout the trading session
  - Integrated into fill processing workflows

- **Enhanced Order Manager**: Better fund tracking and grid management
  - Improved chain order synchronization with price+size matching
  - Grid recalculation for full grid resync with better parameters
  - Enhanced logging and debug output for startup troubleshooting

- **Improved Account Handling**: Better restart operations
  - Set account info on manager during restart for balance calculations
  - Support percentage-based botFunds configuration at restart
  - Fetch on-chain balances before grid initialization if needed

### Fixed
- **Limit Order Update Calculation**: Fixed parameter handling in chain_orders.js
  - Corrected receive amount handling for price-change detection
  - Improved delta calculation when price changes toward/away from market
  - Added comprehensive validation for final amounts after delta adjustment

### Testing
- Comprehensive test coverage for new reconciliation logic
- Test startup decision logic with various grid/chain scenarios
- Test TwentyX-specific edge cases and recovery paths

## [0.1.2] - 2025-12-10 - Multi-Bot Fund Allocation & Update Script

### Features
- **Multi-Bot Fund Allocation**: Enforce botFunds percentage allocation when multiple bots share an account
  - Each bot respects its allocated percentage of chainFree (what's free on-chain)
  - Bot1 with 90% gets 90% of chainFree, Bot2 with 10% gets 10% of remaining
  - Prevents fund allocation conflicts in shared accounts
  - Applied at grid initialization for accurate startup sizing

### Fixed
- **Update Script**: Removed interactive merge prompts by using `git pull --rebase`
- **Script Permissions**: Made update.sh permanently executable via git config

## [0.1.1] - 2025-12-10 - Minimum Delta Enforcement

### Features
- **Minimum Delta Enforcement**: Enforce meaningful blockchain updates for price-only order moves
  - When price changes but amount delta is zero, automatically set delta to ±1
  - Only applies when order moves toward market center (economically beneficial)
  - Prevents wasted on-chain transactions for imperceptible price changes
  - Maintains grid integrity by pushing orders toward spread

### Fixed
- Eliminated zero-delta price-only updates that had no economic effect
- Improved order update efficiency for partial order price adjustments

## [0.1.0] - 2025-12-10 - Initial Release

### Features
- **Staggered Order Grid**: Geometric order grids with configurable weight distribution
- **Dynamic Rebalancing**: Automatic order updates after fills
- **Multi-Bot Support**: Run multiple bots simultaneously on different pairs
- **PM2 Process Management**: Production-ready process orchestration with auto-restart
- **Partial Order Handling**: Atomic moves for partially-filled orders
- **Fill Deduplication**: 5-second deduplication window prevents duplicate processing
- **Master Password Security**: Encrypted key storage with RAM-only password handling
- **Price Tolerance**: Intelligent blockchain rounding compensation
- **API Resilience**: Multi-API support with graceful fallbacks
- **Dry-Run Mode**: Safe simulation before live trading

### Fixed
- **Fill Processing in PM2 Mode**: Implemented complete 4-step fill processing pipeline for PM2-managed bots
  - Fill validation and deduplication
  - Grid synchronization with blockchain
  - Batch rebalancing and order updates
  - Proper order rotation with atomic transactions
- **Fund Fallback in Order Rotation**: Added fallback to available funds when proceeds exhausted
- **Price Derivation Robustness**: Enhanced pool price lookup with multiple API variant support


### Installation & Usage
See README.md for detailed installation and usage instructions.

### Documentation
- README.md: Complete feature overview and configuration guide
- modules/: Comprehensive module documentation
- examples/bots.json: Configuration templates
- tests/: 25+ test files covering all major functionality

### Notes
- First production-ready release for BitShares DEX market making
- Always test with `dryRun: true` before enabling live trading
- Secure your keys; do not commit private keys to version control
- Use `profiles/` directory for live configuration (not tracked by git)

