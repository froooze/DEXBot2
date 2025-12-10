# DEXBot2 v0.1.1 - Minimum Delta Enforcement

**Release Date:** 2025-12-10
**Tag:** `v0.1.1`
**Git Commit:** `10c878f`

## What Changed

### Feature: Minimum Delta Enforcement

When updating partial orders with price changes but zero amount delta, the system now automatically enforces a minimum delta of ±1 to ensure meaningful blockchain updates.

**Problem Solved:**
- Previously, updating a partial order's price without changing its size would result in zero delta
- Zero-delta updates were sent to the blockchain but had no economic effect
- This wasted blockchain transactions and fees without moving the order toward market center

**Solution:**
- Detect when `deltaSellInt === 0` but `priceChanged === true`
- Check if the price move is toward market center (economically beneficial)
- If yes: automatically set `deltaSellInt = 1`
- If no (moving away from market): allow zero delta with warning log

**Impact:**
- All partial order price updates now have meaningful economic effect
- Orders automatically move toward market center by one precision unit when needed
- Reduced wasted blockchain transactions
- Better grid integrity maintenance

**Code Changes:**
- **File:** `modules/chain_orders.js`
- **Function:** `buildUpdateOrderOp()`
- **Lines Added:** 24 (lines 340-362)
- **Logic:** Enforce minimum delta only when economically beneficial (toward market)

## Installation

### Option 1: Fresh Installation (Recommended for v0.1.1 first-time users)

```bash
cd ~/DEXBot2
git clone https://github.com/froooze/DEXBot2.git DEXBot2
cd DEXBot2
git checkout v0.1.1
npm install
npm run bootstrap:profiles
node dexbot.js keys
node dexbot.js bots
npm run pm2:unlock-start
```

### Option 2: Upgrade from v0.1.0

```bash
cd ~/DEXBot2
git fetch origin
git checkout v0.1.1
npm install
npm run pm2:unlock-start
```

### Option 3: Update Existing Installation

```bash
cd ~/DEXBot2/scripts
chmod +x update.sh
./update.sh
```

The script will:
1. Stash your local changes
2. Backup your profile configuration
3. Fetch and merge the latest v0.1.1
4. Restore your profiles if there are no conflicts

## What's New in v0.1.1

- ✅ Minimum delta enforcement for price-only updates
- ✅ Automatic order adjustment toward market center
- ✅ Reduced wasted blockchain transactions
- ✅ Better partial order handling

## Features from v0.1.0 (Still Included)

- Staggered order grids with geometric spacing
- Dynamic rebalancing after fills
- Multi-bot support on different trading pairs
- PM2 process management with auto-restart
- Partial order atomic moves
- Fill deduplication (5-second window)
- Master password security (encrypted storage, RAM-only)
- Price tolerance for blockchain rounding compensation
- Multi-API support with graceful fallbacks
- Dry-run mode for safe simulation

## Quick Usage

### Start Single Bot (Development)
```bash
node dexbot.js start <bot-name>
```

### Start Multi-Bot (Production - PM2)
```bash
node pm2.js
```

### View Logs
```bash
# All bots
pm2 logs

# Specific bot
pm2 logs <bot-name>

# Follow real-time
tail -f profiles/logs/<bot-name>.log
```

### Stop/Restart
```bash
pm2 stop <bot-name>
pm2 restart <bot-name>
pm2 delete <bot-name>
```

## Testing

Before running live:

```bash
# Test with dry-run enabled in bots.json
{
  "dryRun": true,
  ...
}

# Start bot
node dexbot.js start <bot-name>

# Check logs - should show order placement but no blockchain transactions
tail -f profiles/logs/<bot-name>.log
```

## Documentation

- **README.md** - Complete feature overview and configuration guide
- **CHANGELOG.md** - Full version history
- **modules/** - Source code with inline documentation
- **tests/** - 25+ test files covering all functionality
- **examples/bots.json** - Configuration templates

## Support & Issues

- GitHub Issues: https://github.com/froooze/DEXBot2/issues
- Discussions: https://github.com/froooze/DEXBot2/discussions

## Security Notes

- Master password is encrypted and stored in `profiles/keys.json`
- Private keys never written to disk (RAM only during operation)
- Always use PM2 for production (handles crashes + restarts)
- Test with `dryRun: true` before enabling live trading
- Keep `profiles/` directory excluded from version control

## Known Issues

None at this time.

## Release Checklist

- ✅ Code tested locally
- ✅ CHANGELOG.md updated
- ✅ Git commit pushed (10c878f)
- ✅ v0.1.1 tag created
- ✅ GitHub release published
- ✅ Documentation current
- ✅ No uncommitted changes
