# Branch Workflow: test → dev → main

This document describes the branch strategy for DEXBot2 development.

## Branch Hierarchy

```
feature branches
       ↓
    test (testing/staging branch)
       ↓
    dev (active development integration)
       ↓
    main (stable/production releases)
```

## Branch Purposes

- **test**: Primary development branch where feature work lands
- **dev**: Integration/staging branch (receives merges from test)
- **main**: Stable, production-ready branch
- **feature/\***: Feature branches for specific features/fixes

## Agent Git Action Gate (User-Directed Writes)

Agents (AI coding assistants) must **not** proactively ask for or execute git
write actions — they only run them when the user clearly requests them. Git write
actions include: `git add`, `git commit`, `git commit --amend`, `git reset` (any
mode), `git rebase`, `git merge`, `git push`, `git tag`, and branch switching
(`git checkout` / `git switch`). Read-only git commands (`git status`, `git diff`,
`git log`, `git show`) are always allowed.

Interpretation rules:
1. If a user clearly asks for a git write action, execute it.
2. Short approvals like "yes", "ok", "do it", or "go ahead" are valid confirmation
   when they clearly refer to the immediately previous proposed action.
3. If wording is ambiguous, ask one clarifying question before running destructive
   actions.
4. `git commit --amend` is allowed when explicitly requested by the user.
5. Before a git write action, restate the user authorization in one short line.

The branch-promotion scripts (`npm run ptest` / `pdev` / `pmain`) count as git
write actions too — use them only when the user explicitly asks.

## Workflow

### 1. Creating a Feature

```bash
# Start from test (latest testing branch)
git checkout test
git pull origin test

# Create feature branch
git checkout -b feature/my-feature test
```

### 2. Working on a Feature

```bash
# Make your changes, commit as normal
git add .
git commit -m "feat: describe your feature"

# Push to remote when ready for review
git push -u origin feature/my-feature
```

### 3. Testing & Integration

```bash
# When ready for testing, create PR: feature/my-feature → test
# After review and testing passes:
git checkout test
git pull origin test
git merge --no-ff feature/my-feature
git push origin test

# Delete feature branch after merging
git branch -D feature/my-feature
git push origin --delete feature/my-feature
```

### 4. Merging to Dev

```bash
# After test branch is validated and tested
git checkout dev
git pull origin dev
git merge --no-ff test
git push origin dev
```

### 5. Releasing to Main

```bash
# When code is stable and ready for production
git checkout main
git pull origin main
git merge --no-ff dev
git push origin main

# Tag releases
git tag -a v0.X.Y -m "Release version 0.X.Y"
git push origin v0.X.Y
```

## Current Branch Status

Run `git branch -vv` and `git log --oneline main..test | wc -l` / `git log --oneline main..dev | wc -l` for live commit counts.

## Architectural Safety: Copy-on-Write

DEXBot2 uses a **Copy-on-Write (COW)** grid architecture to prevent state corruption during rebalancing. This is relevant to all developers contributing code:

- The master grid (`manager.orders`) is **immutable** — frozen with `Object.freeze()` and never mutated in place.
- All strategy and rebalancing logic runs on an isolated `WorkingGrid` clone.
- The master is replaced atomically only after blockchain confirmation (`_commitWorkingGrid()`).
- On any failure, the working grid is discarded and the master remains unchanged.

This means feature branches that touch rebalancing, grid planning, or order state changes **must** operate on `WorkingGrid`, not `manager.orders` directly. See [COPY_ON_WRITE_MASTER_PLAN.md](COPY_ON_WRITE_MASTER_PLAN.md) for the full specification and [developer_guide.md#copy-on-write-cow-development-rules](developer_guide.md#copy-on-write-cow-development-rules) for coding rules.

Before promoting `test` -> `dev`, review [COW_INVARIANTS.md](COW_INVARIANTS.md) for the current stable-theory contract and confirm touched COW/accounting changes still satisfy those invariants.

---

## Key Rules

### ✅ DO:
- Always pull before creating a feature branch
- Use `--no-ff` flag for merge commits to maintain history
- Work on **test** branch (primary development)
- Push **test** to origin/test
- Merge **test INTO dev** when stable
- Push **dev** after merging from test
- Keep dev and main clean (no direct commits)
- Use feature branches for larger features
- Code review should happen on feature → test PRs
- Integration testing happens on test branch
- Only merge to dev after test validation
- Only merge to main for releases

### ❌ DON'T:
- Never merge dev → test (wrong direction!)
- Never force push to test, dev, or main
- Never commit directly to dev or main
- Never push dev without merging from test first
- Never forget to pull before merging

## Verification & Synchronization

### Check Branch Status
```bash
# View all branches with tracking
git branch -vv

# Count commits ahead of main
echo "test:" && git log --oneline main..test | wc -l
echo "dev:" && git log --oneline main..dev | wc -l

# Both should show the same number
```

### Sync test with dev
The pipeline is one-directional: `test → dev`, never `dev → test`. If `test`
appears to be missing commits that `dev` has, do **not** merge `dev` into
`test` (this is the forbidden direction — see DON'T below). Instead:

```bash
# Check what dev has that test does not
git log --oneline test..dev

# Cherry-pick the specific missing commits forward into test if needed
git checkout test
git pull origin test
git cherry-pick <commit-hash>
git push origin test

# Verify sync counts (both should show the same number)
git log --oneline main..test | wc -l
git log --oneline main..dev | wc -l
```

### Daily Workflow Summary
```bash
# Morning: Start on test
git checkout test
git pull origin test

# During day: Make changes
git add .
git commit -m "feat: description"
git push origin test

# When ready to integrate
git checkout dev
git pull origin dev
git merge --no-ff test
git push origin dev

# Back to test for next cycle
git checkout test
git pull origin test
```

## Recommended Runtime: `start`

DEXBot2 runs as a **monolithic daemon** (`dexbot start`). This is the production-
recommended mode:

- **Single process** — no PM2, no separate credential daemon management
- **Optional auto-update** — `dexbot update` (or `UPDATER.ACTIVE` in general settings, **default off**) pulls, builds and restarts cleanly; by default the bot only *reports* that a newer release exists
- **Crash restart** — background mode re-spawns on failure
- **Per-bot log files** — each bot logs to `<profiles>/logs/<bot>.log` (`~/.config/dexbot2/profiles/logs` by default)
- **Built-in daemon** — the credential daemon is managed internally

Legacy PM2 mode (`npm run pm2:unlock`) is de-emphasized but still available.

```bash
# Start as background daemon (default)
dexbot start

# Start in foreground (interactive)
dexbot start --foreground

# Start with claw automation
dexbot start --claw-only

# Start credit-only worker in the background (no grid trading, just credit runtime)
dexbot start credit
```

### Overview of CLI Commands

The `dexbot <subcommand>` family provides runtime management. Run
`dexbot --help` for the full canonical list. Aliases are accepted but
the canonical name is preferred in scripts and docs.

| Command (canonical) | Aliases | Purpose |
|---------|---------|---------|
| `dexbot test <bot>` | — | Run a single bot in live mode (one-shot; not a dry run) |
| `dexbot drystart <bot>` | — | Same as `test` but forces dry-run execution |
| `dexbot reset <bot>` | — | Trigger a grid reset (applies live or on next start; `reset all` for all) |
| `dexbot default` | `defaults` | Reset settings to defaults (deletes generated settings files) |
| `dexbot disable <bot>` | — | Mark a bot inactive in config (`disable all` for all) |
| `dexbot enable <bot>` | — | Mark a bot active in config (`enable all` for all) |
| `dexbot key` | `keys` | Launch the chain key helper (`modules/chain_keys.ts`) |
| `dexbot bot` | `bots` | Launch the interactive bot configurator |
| `dexbot pm2` | — | Start all active bots via PM2 |
| `dexbot update` | — | Update DEXBot2 from the repository and restart active bots |
| `dexbot export <bot>` | — | Export bot trades/settings to CSV/JSON for local analysis/ |
| `dexbot order` | `orders` | Analyze persisted order grids (spread, increment, funds); `--export` for HTML |
| `dexbot order [<bot>]` | — | Analyze only the specified bot's order grid |
| `dexbot credit` | — | Live summed MPA + borrowed-credit positions per asset per bot (`[<bot>]`) |
| `dexbot rich <asset...>` | — | Top holder(s) per asset via the chain asset-holders API (`--top N`, `--json`/`--csv`) |
| `dexbot tv <target>` | — | TradingView 1h chart for `<bot|pool-id|AssetA/AssetB>` over `--month N` (default 3) |
| `dexbot dw <target>` | — | Dynamic-weight research chart: same targets/flags as `tv` |
| `dexbot liquid <target>` | `liquidity` | Blended order-book + AMM pool liquidity depth chart for `<bot|AssetA/AssetB>` (`--range`, `--depth`, `--steps`) |
| `dexbot pnl <account>` | — | HTML PnL report for a bot/account over `--month N`, optional `--pair BASE/QUOTE` filter |
| `dexbot git` | — | Analyze repository git history and write an added/deleted-lines HTML chart (`repo-stats.html`; source checkouts only) |
| `dexbot status` | `stat`, `stats` | Unified runtime health — daemon, adapter, bots. Whole-runtime: an optional bot name is validated, then ignored |
| `dexbot start` | `unlock` | Run credential daemon + bot (equivalent to running the `unlock` runtime, `dist/unlock.js`) |
| `dexbot stop [<bot>]` | `stp`, `stopall` | Stop the runtime. Monolithic: whole runtime (a bot argument folds into it with a notice); `--isolated`: just that bot |
| `dexbot reload [<bot>]` | `reloadall` | Reload without touching the credential daemon. Same per-bot target rules as `stop` |
| `dexbot restart [<bot>]` | `restartall` | Restart and re-unlock the credential daemon. Same per-bot target rules as `stop` |
| `dexbot delete` | — | Shut down and clean up the monolithic runtime. Whole-runtime only; rejects a bot argument |
| `dexbot clear` | — | Delete `*.log`, rotated `*.log.*` and `*.jsonl*` from the logs directory (`<profiles>/logs`) |
| `dexbot clear-orders` | — | Delete all persisted order files (`<profiles>/orders`); grids regenerate on next start |
| `dexbot clear-market-adapter` | — | Delete market adapter data, state (incl. `market_adapter.lock`), and adapter logs |
| `dexbot clear-all` | — | Delete orders, logs, market adapter, and claw data (all of the above) |
| `dexbot help` | — | Print the full CLI reference (grouped by Runtime/Trading/Config/Analysis/Files) |

> ⚠️ **The `clear*` commands are offline-only** — stop the runtime first
> (`dexbot stop` / `dexbot pm2 stop all`). They detect a live runtime (pid files
> + this install's online PM2 apps) and warn, but the warning is advisory: the
> deletion still runs, a live bot re-creates the state within seconds, and open
> log FDs keep the disk space until it restarts.
>
> `clear*` never touches config — `bots.json`, `keys.json`, the settings files and
> `credit_runtime/` survive. `clear` / `clear-all` do delete the credential audit
> trail `logs/daemon-audit.jsonl` (and its rotated siblings) along with the rest
> of the logs; the preview names it explicitly.

## NPM Scripts for Branch Synchronization

The following npm scripts provide safe, automated branch synchronization:

```bash
# Sync local test to origin/test (safe, no branch switching)
npm run ptest

# Sync test to dev with safe remote push
npm run pdev

# Promote dev to main (full release)
npm run pmain
```

### Script Details

> ⚠️ **Scripts use `--force`, not `--no-ff` merges.** The manual merge flow
> (steps 3–5 above) creates real merge commits and preserves history. The
> sync scripts instead **force-push** `test` to downstream branches, which
> rewrites `dev`/`main` to exactly match `test`. This deliberately bypasses
> the "never force push to dev/main" guard rail (see Key Rules below), so
> **only run them when you explicitly intend a fast-forward release** and
> `test == dev == main` is the desired end state. Prefer the manual merge
> flow for normal promotion; reach for the scripts only when you want
> zero-divergence sync.

| Script | Purpose | What It Does | When to Use |
|--------|---------|-------------|-----------|
| `npm run ptest` | Push test to origin | Checks out `test` (if not on it) and pushes local commits to `origin/test`. Does **not** touch `dev`/`main`. | Daily development; ensures `origin/test` is up-to-date |
| `npm run pdev` | Mirror test onto dev | Pushes `origin/test`, then `git push origin test:dev --force` and updates the local `dev` pointer. No merge commit. | When test is stable and you want `dev` to exactly equal `test` |
| `npm run pmain` | Mirror test onto dev and main | Pushes `origin/test`, then force-pushes `test` to both `dev` and `main` and updates local pointers. **No tagging.** | Full release where `test == dev == main` is intended. Tag manually afterward (see step 5) |

Note: `pmain` does **not** create a release tag. Run `git tag -a v0.X.Y -m "..."` manually after `pmain` if you need a tagged release point.

## Commands Summary

```bash
# Setup - Start on test (primary branch)
git checkout test
git pull origin test

# Feature work - Use feature branches for organized work
git checkout -b feature/xyz test
# ... make changes ...
git push -u origin feature/xyz
# ... create PR for review ...

# Merge to test - Integrate feature into primary branch
git checkout test && git pull && git merge --no-ff feature/xyz && git push origin test

# Quick: Push local test to origin/test (checks out test if needed)
npm run ptest

# Force-mirror test onto dev (no merge commit; sees Script Details above)
npm run pdev

# Force-mirror test onto dev + main (no merge commit, no tagging)
npm run pmain
# Tag a release manually afterward if needed:
git tag -a v0.X.Y -m "Release version 0.X.Y" && git push origin v0.X.Y
```

## Troubleshooting

### If you accidentally merged dev into test:
```bash
# Undo the merge on test
git checkout test
git reset --hard HEAD~1

# Verify
git log --oneline -5

# Push to fix remote
git push origin test --force-with-lease
```

### If test is missing commits from dev:
```bash
# This shouldn't happen in normal workflow
# But if it does, identify and cherry-pick missing commits
git checkout test
git log --oneline main..dev  # See what dev has
git log --oneline main..test # See what test has

# Cherry-pick missing commits
git cherry-pick <commit-hash>
git push origin test
```

### If you committed directly to dev (should not happen):
```bash
# Revert from dev
git checkout dev
git revert <commit-hash>
git push origin dev

# Cherry-pick to test if needed
git checkout test
git cherry-pick <commit-hash>
git push origin test

# Fix dev via merge
git checkout dev
git merge test
git push origin dev
```
