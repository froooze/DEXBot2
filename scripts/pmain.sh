#!/bin/bash
set -e

# Professional Branch Synchronization Script (Remote Push Mode)
# Pipeline: test -> dev -> main
# This script ensures that dev and main are always up-to-date with test
# WITHOUT switching branches or using 'reset --hard', protecting uncommitted changes.

echo "🔄 Starting safe branch synchronization..."

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
# This works even if you have uncommitted changes.
echo "📤 Pushing 'test' commits to origin..."
if ! git push origin test; then
  echo "❌ Push failed. You might be behind origin/test or have a conflict."
  echo "⚠️ Please check 'git status' or sync manually."
  exit 1
fi

# 4. Force update 'dev' and 'main' on origin in ONE atomic push (Zero-Checkout)
# --atomic makes the mirror all-or-nothing: either both branches move or neither
# does, so a refusal can never leave dev ahead of main.
echo "🚀 Synchronizing 'dev' and 'main' with 'test' on origin (atomic)..."
if ! git push --atomic origin test:dev test:main --force; then
  echo "❌ Atomic push to dev/main failed — neither branch was moved."
  echo "⚠️ Please check 'git status' or sync manually."
  exit 1
fi

# 5. Update local branch pointers to match origin
# Best-effort: the atomic push above already moved origin, so a failure here is
# cosmetic (a stale local label) and self-heals on the next successful fetch.
echo "📍 Updating local branch pointers..."
if ! git fetch origin dev:dev main:main --force; then
  echo "⚠️  Local 'dev'/'main' pointers were not refreshed — origin is already synced."
  echo "    Re-run 'npm run pmain' once the remote is reachable again."
  exit 1
fi

echo "✅ Everything is synchronized: test == dev == main"
echo "✨ Your uncommitted changes on 'test' were never at risk."

