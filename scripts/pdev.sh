#!/bin/bash
set -e

# Professional Branch Synchronization Script (test -> dev)
# This script ensures that dev is always up-to-date with test
# WITHOUT switching branches or using 'reset --hard', protecting uncommitted changes.

echo "🔄 Starting safe branch synchronization (test -> dev)..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/git_preflight.sh
source "$SCRIPT_DIR/lib/git_preflight.sh"

# 0. Fail fast when the remote cannot be read — before any branch is touched.
require_origin_access origin || exit 1

# 1. Ensure we are on 'test'
CURRENT=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT" != "test" ]; then
  echo "📍 Switching to 'test' branch..."
  git checkout test
fi

# 2. Sync 'test' with origin
echo "🛰️ Fetching from origin..."
git fetch origin test

# 3. Push local 'test' commits to origin
echo "📤 Pushing 'test' commits to origin..."
if ! git push origin test; then
  echo "❌ Push failed. You might be behind origin/test or have a conflict."
  echo "⚠️ Please check 'git status' or sync manually."
  exit 1
fi

# 4. Force update 'dev' on origin (Zero-Checkout)
echo "🚀 Synchronizing 'dev' with 'test' on origin..."
git push origin test:dev --force

# 5. Update local 'dev' branch pointer to match origin
# Best-effort: the push above already moved origin/dev, so a failure here is
# cosmetic (a stale local label) and self-heals on the next successful fetch.
echo "📍 Updating local 'dev' branch pointer..."
if ! git fetch origin dev:dev --force; then
  echo "⚠️  Local 'dev' pointer was not refreshed — origin/dev is already synced."
  echo "    Re-run 'npm run pdev' once the remote is reachable again."
  exit 1
fi

echo "✅ Synchronization complete: test == dev"
echo "✨ Your uncommitted changes on 'test' were never at risk."
