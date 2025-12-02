#!/usr/bin/env bash
set -euo pipefail

# sync.sh - quick helper to safely add/commit/push changes in this repo.
# Usage: ./sync.sh [commit message]
# By default the message is "update".

COMMIT_MSG=""
MSG_PROVIDED=0
DRY=0

function usage() {
    cat <<'USAGE' >&2
Usage: sync.sh [options] [commit-message]

Options:
    -h, --help        Show this help and exit
    -n, --dry-run     Do not commit or push; show what would happen
    -m, --message MSG Use MSG as the commit message (if omitted, message arg is used)

Examples:
    sync.sh "Update config"
    sync.sh --dry-run
    sync.sh -m "Update bot config"
USAGE
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        -n|--dry-run) DRY=1; shift ;;
        -m|--message)
            shift
            COMMIT_MSG="${1:-}";
            MSG_PROVIDED=1
            shift
            ;;
        --) shift; break ;;
        -*) echo "Unknown option: $1"; usage; exit 2 ;;
        *) COMMIT_MSG="$1"; MSG_PROVIDED=1; shift ;;
    esac
done

function die { echo "ERROR: $*" >&2; exit 1; }

function summarize_changes() {
    local files=()
    while IFS= read -r line; do
        [ -n "$line" ] && files+=("$line")
    done < <(git diff --cached --name-only)
    if [ ${#files[@]} -eq 0 ]; then
        echo "no tracked files"
        return
    fi
    local max=4
    local summary=""
    for i in "${!files[@]}"; do
        if [ "$i" -ge "$max" ]; then
            summary+=" +$(( ${#files[@]} - max )) more"
            break
        fi
        local name=$(basename "${files[i]}")
        summary+="$name"
        if [ $i -lt $(( ${#files[@]} - 1 )) ] && [ $i -lt $((max - 1)) ]; then
            summary+=", "
        fi
    done
    echo "$summary"
}

function generate_commit_message() {
    local change_summary
    change_summary=$(summarize_changes)
    if [ "$change_summary" = "no tracked files" ]; then
        echo "Sync: misc changes"
    else
        echo "Sync: $change_summary"
    fi
}

# Ensure we are in a git repository
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    die "Not a git repository (or no git available); run this within a repository."
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Get current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "Repository: $REPO_ROOT"
echo "Branch: $BRANCH"

# Check if there are any changes
if [ -z "$(git status --porcelain)" ]; then
    echo "No changes to add/commit"; exit 0
fi

echo "Staging changes..."
git add -A

if [ "$MSG_PROVIDED" -eq 0 ] && [ -z "$COMMIT_MSG" ]; then
    COMMIT_MSG=$(generate_commit_message)
fi
echo "Commit message: $COMMIT_MSG"

# Try to commit, if nothing to commit skip
if [ "$DRY" -eq 1 ]; then
    echo "Dry-run enabled: git commit not performed (would use message: $COMMIT_MSG)";
else
    if git commit -m "$COMMIT_MSG"; then
        echo "Commit created."
    else
        echo "Nothing to commit or commit failed"; exit 0
    fi
fi

if [ "$DRY" -eq 1 ]; then
    echo "Dry-run: not pushing to origin/$BRANCH"
else
    echo "Pushing to origin/$BRANCH..."
    git push origin "$BRANCH"
fi

echo "All done."
