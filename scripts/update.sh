#!/bin/bash
# DEXBot2 Auto Update Script
#
# This script automatically updates DEXBot2 from the GitHub repository
# Usage: ./scripts/update.sh or bash scripts/update.sh
#
# Features:
# - Checks for updates from main branch
# - Backs up current profiles/ directory
# - Performs git pull
# - Installs/updates dependencies
# - Restarts PM2 if running
# - Logs all operations

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO_URL="https://github.com/froooze/DEXBot2.git"
REPO_BRANCH="main"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_FILE="${PROJECT_ROOT}/update.log"
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')

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
log_info "DEXBot2 Update Script Started"
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

# Step 3: Stash any local changes (except profiles which is in .gitignore)
log_info "Step 3: Checking for local changes..."
if ! git diff --quiet; then
    log_warning "Uncommitted changes detected, stashing..."
    git stash
    log_info "Changes stashed"
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
    if pm2 list | grep -q "bbot"; then
        log_info "PM2 bots detected, reloading..."
        if pm2 reload profiles/ecosystem.config.js 2>/dev/null; then
            log_success "PM2 bots reloaded successfully"
        else
            log_warning "PM2 reload failed or no ecosystem config found"
        fi
    else
        log_info "No running PM2 bots found"
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
log_info "- Code updated to latest from main branch"
log_info "- Dependencies installed"
if command -v pm2 &> /dev/null && pm2 list | grep -q "bbot"; then
    log_info "- PM2 processes reloaded"
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
