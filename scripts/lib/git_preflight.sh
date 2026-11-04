#!/bin/bash
# Shared preflight for the branch-promotion scripts (ptest / pdev / pmain).
#
# `git push` is the first step that discovers a dead auth path, and it discovers
# it halfway through a promotion: origin/test moves, then origin/dev is refused,
# and origin/main is never attempted. One read-only round trip up front makes
# that failure arrive before any ref is touched.
#
# A real read (`git ls-remote`) is used instead of parsing the greeting of
# `ssh -T`: the greeting is provider-specific ("Hi user!", "Welcome to
# Codeberg, ..."), `ssh -T` exits non-zero even on success, and neither proves
# the repository itself is reachable.
#
# This is a point-in-time probe: a degraded auth path can still fail after it
# passes (that is why pmain's downstream mirror is a single --atomic push, so
# the worst case is "neither branch moved" instead of "dev moved, main did
# not").
#
# Callers must compute SCRIPT_DIR before sourcing:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/lib/git_preflight.sh"
#   require_origin_access origin || exit 1
#
# Set DEXBOT_SKIP_GIT_PREFLIGHT=1 to bypass the check.

# require_origin_access [remote] — 0 when the remote answers a read, 1 otherwise.
require_origin_access() {
    local remote="${1:-origin}"
    local url err

    if [ "${DEXBOT_SKIP_GIT_PREFLIGHT:-0}" = "1" ]; then
        echo "⚠️  DEXBOT_SKIP_GIT_PREFLIGHT=1 — skipping the remote access check."
        return 0
    fi

    if ! url=$(git remote get-url "$remote" 2>/dev/null); then
        echo "❌ Remote '$remote' is not configured — nothing to push to." >&2
        return 1
    fi

    echo "🔑 Checking '$remote' ($url)..."
    # stderr -> capture (for the reason), stdout -> /dev/null (ref list unused).
    if err=$(git ls-remote --heads "$remote" 2>&1 >/dev/null); then
        return 0
    fi

    echo "❌ Cannot read from '$remote' ($url) — no branch was touched." >&2
    if [ -n "$err" ]; then
        # First line is the cause ("... Permission denied (publickey)."); the
        # rest is the provider's localized boilerplate.
        echo "   $(printf '%s\n' "$err" | head -n 1)" >&2
    fi
    echo "   Usual causes: the server no longer accepts this SSH key, a provider" >&2
    echo "   incident, or no network. Verify the remote by hand (e.g." >&2
    echo "   'ssh -T git@github.com'), then re-run. Bypass: DEXBOT_SKIP_GIT_PREFLIGHT=1." >&2
    return 1
}
