#!/bin/bash
set -e

# Professional Branch Synchronization Script (local test -> origin/test)
# This script ensures that origin/test is up-to-date with your local test commits
# WITHOUT switching branches or using 'reset --hard', protecting uncommitted changes.

echo "🔄 Starting safe branch synchronization (test -> origin/test)..."

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

# 2. Push local 'test' commits to origin
echo "📤 Pushing 'test' commits to origin..."
if ! git push origin test; then
  echo "❌ Push failed. You might be behind origin/test."
  echo "⚠️ Please check 'git status' or sync manually."
  exit 1
fi

echo "✅ Synchronization complete: local test == origin/test"
echo "✨ Your uncommitted changes on 'test' were never at risk."
