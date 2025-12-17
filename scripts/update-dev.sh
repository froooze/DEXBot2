#!/bin/bash
# DEXBot2 Auto Update Script (Development Branch)
#
# This script automatically updates DEXBot2 from the GitHub repository dev branch
# Usage: ./scripts/update-dev.sh or bash scripts/update-dev.sh
#
# Features:
# - Checks for updates from dev branch
# - Protects profiles/ directory (excluded from git, never modified)
# - Stashes local changes to modules/constants.js before update
# - Performs git pull with clean working directory
# - Reapplies stashed modules/constants.js changes after update
# - Installs/updates dependencies
# - Restarts PM2 if running
# - Logs all operations
#
# Protected Files:
# - profiles/ - Your bot configurations, profiles, and logs (in .gitignore)
# - modules/constants.js - Local customizations are stashed and reapplied
#
# Note: If conflicts occur during stash reapply, the script will warn you and suggest
# manual resolution using git stash show and git stash drop commands.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO_URL="https://github.com/froooze/DEXBot2.git"
REPO_BRANCH="dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="${PROJECT_ROOT}/profiles/logs"
LOG_FILE="${LOGS_DIR}/update-dev.log"
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')

# Ensure logs directory exists
mkdir -p "$LOGS_DIR"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$LOG_FILE"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" | tee -a "$LOG_FILE"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1" | tee -a "$LOG_FILE"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE"
}

# Check if we're in the project root
if [ ! -f "$PROJECT_ROOT/dexbot.js" ]; then
    log_error "Script must be run from DEXBot2 root directory"
    exit 1
fi

log_info "=========================================="
log_info "DEXBot2 Update Script Started (Dev Branch)"
log_info "=========================================="
log_info "Project Root: $PROJECT_ROOT"
log_info "Branch: $REPO_BRANCH"
log_info "Timestamp: $TIMESTAMP"

# Note: profiles/ directory is in .gitignore and is not backed up during updates
# Your configuration files are safe and will not be affected by the update

# Step 1: Check git status
log_info "Step 1: Checking git status..."
cd "$PROJECT_ROOT"
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    log_error "Not a git repository"
    exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
log_info "Current branch: $CURRENT_BRANCH"

# Step 2: Protect profiles directory (ensure it won't be touched)
log_info "Step 2: Protecting profiles directory..."
if [ -d "$PROJECT_ROOT/profiles" ]; then
    # Ensure profiles is properly ignored by git
    if ! grep -q "profiles/" "$PROJECT_ROOT/.gitignore" 2>/dev/null; then
        log_warning "Warning: profiles/ not in .gitignore, adding it..."
        echo "profiles/" >> "$PROJECT_ROOT/.gitignore"
    fi
    log_success "Profiles directory is protected and will not be modified"
else
    log_info "No profiles directory found (will be created on first run)"
fi

# Step 3: Auto-checkout to dev branch if not already on it
CONSTANTS_STASHED=false
if [ "$CURRENT_BRANCH" != "$REPO_BRANCH" ]; then
    log_info "Step 3: Switching to $REPO_BRANCH branch..."
    # Stash local changes to modules/constants.js before switching
    if ! git diff --quiet -- modules/constants.js 2>/dev/null; then
        log_info "Stashing local changes to modules/constants.js..."
        if git stash push -m "DEXBot2 update backup: modules/constants.js" -- modules/constants.js; then
            CONSTANTS_STASHED=true
            log_success "Local modules/constants.js changes stashed"
        else
            log_warning "Failed to stash modules/constants.js"
        fi
    fi
    # Discard any remaining changes before switching (clean working directory required)
    if ! git diff --quiet || ! git diff --cached --quiet; then
        git checkout -- .
        git clean -fd
    fi
    if git checkout "$REPO_BRANCH"; then
        log_success "Switched to $REPO_BRANCH branch"
    else
        log_error "Failed to checkout $REPO_BRANCH branch"
        exit 1
    fi
else
    log_info "Step 3: Cleaning working directory..."
    # Stash local changes to modules/constants.js before cleaning
    if ! git diff --quiet -- modules/constants.js 2>/dev/null; then
        log_info "Stashing local changes to modules/constants.js..."
        if git stash push -m "DEXBot2 update backup: modules/constants.js" -- modules/constants.js; then
            CONSTANTS_STASHED=true
            log_success "Local modules/constants.js changes stashed"
        else
            log_warning "Failed to stash modules/constants.js"
        fi
    fi
    # Always clean working directory before pull (profiles/ excluded by .gitignore)
    if ! git diff --quiet || ! git diff --cached --quiet; then
        git checkout -- .
        git clean -fd
    fi
fi

# Step 4: Fetch latest from GitHub
log_info "Step 4: Fetching latest from GitHub..."
if git fetch origin "$REPO_BRANCH"; then
    log_success "Fetched latest from origin"
else
    log_error "Failed to fetch from GitHub"
    exit 1
fi

# Step 5: Check if there are updates
log_info "Step 5: Checking for available updates..."
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$REPO_BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
    log_success "Already up to date!"
    log_info "=========================================="
    exit 0
fi

log_info "Updates available, pulling changes..."

# Step 6: Pull latest code (use --rebase to avoid merge prompts)
if git pull --rebase origin "$REPO_BRANCH"; then
    log_success "Successfully pulled latest code"
else
    log_error "Failed to pull latest code"
    exit 1
fi

# Step 6.5: Reapply stashed modules/constants.js changes
if [ "$CONSTANTS_STASHED" = true ]; then
    log_info "Step 6.5: Reapplying stashed modules/constants.js changes..."
    if git stash pop; then
        log_success "Successfully reapplied modules/constants.js changes"
    else
        log_warning "Stash reapply had conflicts or failed. Manual merge may be needed."
        log_info "To resolve: git stash show and git stash drop when ready"
    fi
fi

# Step 7: Install/update dependencies
log_info "Step 7: Installing/updating dependencies..."
if npm install --prefer-offline; then
    log_success "Dependencies installed successfully"
else
    log_warning "npm install completed with warnings"
fi

# Step 8: Check for PM2 running
log_info "Step 8: Checking PM2 status..."
if command -v pm2 &> /dev/null; then
    # Read bot names from bots.json and collect running ones
    if [ -f "$PROJECT_ROOT/profiles/bots.json" ]; then
        # Extract bot names from bots.json and check if any are running
        RUNNING_BOTS=()
        while IFS= read -r bot_name; do
            if pm2 list | grep -q "$bot_name"; then
                RUNNING_BOTS+=("$bot_name")
            fi
        done < <(grep -o '"name": "[^"]*"' "$PROJECT_ROOT/profiles/bots.json" | sed 's/"name": "//;s/"$//')

        if [ ${#RUNNING_BOTS[@]} -gt 0 ]; then
            log_info "PM2 bots detected (${#RUNNING_BOTS[@]} running): ${RUNNING_BOTS[*]}"
            log_info "Reloading running bots only..."
            RELOAD_FAILED=false
            for bot_name in "${RUNNING_BOTS[@]}"; do
                if pm2 reload "$bot_name" 2>/dev/null; then
                    log_info "Reloaded: $bot_name"
                else
                    log_warning "Failed to reload: $bot_name"
                    RELOAD_FAILED=true
                fi
            done
            if [ "$RELOAD_FAILED" = false ]; then
                log_success "PM2 bots reloaded successfully"
            else
                log_warning "Some PM2 reloads failed"
            fi
        else
            log_info "No running PM2 bots found"
        fi
    else
        log_info "No bots.json found, skipping bot detection"
    fi
else
    log_info "PM2 not installed, skipping restart"
fi

# Step 9: Summary
log_info "=========================================="
log_success "Update completed successfully!"
log_info "=========================================="
log_info ""
log_info "Summary:"
log_info "- Code updated to latest from dev branch"
log_info "- Dependencies installed"
# Check if any bots from bots.json are running
if command -v pm2 &> /dev/null && [ -f "$PROJECT_ROOT/profiles/bots.json" ]; then
    SUMMARY_RUNNING_BOTS=()
    while IFS= read -r bot_name; do
        if pm2 list | grep -q "$bot_name"; then
            SUMMARY_RUNNING_BOTS+=("$bot_name")
        fi
    done < <(grep -o '"name": "[^"]*"' "$PROJECT_ROOT/profiles/bots.json" | sed 's/"name": "//;s/"$//')

    if [ ${#SUMMARY_RUNNING_BOTS[@]} -gt 0 ]; then
        log_info "- PM2 processes reloaded (${#SUMMARY_RUNNING_BOTS[@]}): ${SUMMARY_RUNNING_BOTS[*]}"
    fi
fi
log_info "- Your profiles/ directory is safe and unchanged"
log_info ""
log_info "Log file: $LOG_FILE"
log_info ""
log_info "Next steps:"
log_info "- Review the changes with: git log --oneline -n 5"
log_info "- Check status with: pm2 status"
log_info "- View logs with: pm2 logs"
log_info ""

exit 0
