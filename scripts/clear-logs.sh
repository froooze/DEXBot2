#!/bin/bash
# Clear all log files from profiles/logs directory
#
# This script safely removes all log files while preserving the logs directory structure.
# Usage: ./scripts/clear-logs.sh or bash scripts/clear-logs.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="${PROJECT_ROOT}/profiles/logs"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_info "=========================================="
log_info "DEXBot2 Clear Logs Script"
log_info "=========================================="
log_info "Logs Directory: $LOGS_DIR"

# Check if logs directory exists
if [ ! -d "$LOGS_DIR" ]; then
    log_warning "Logs directory does not exist: $LOGS_DIR"
    log_info "Nothing to clean"
    exit 0
fi

# Count log files
LOG_COUNT=$(find "$LOGS_DIR" -type f -name "*.log" 2>/dev/null | wc -l)

if [ "$LOG_COUNT" -eq 0 ]; then
    log_info "No log files found in $LOGS_DIR"
    exit 0
fi

log_info "Found $LOG_COUNT log file(s) to delete"
log_info ""

# Show what will be deleted
log_info "Log files to be deleted:"
find "$LOGS_DIR" -type f -name "*.log" 2>/dev/null | while read file; do
    SIZE=$(du -h "$file" | cut -f1)
    echo -e "${BLUE}  -${NC} $(basename "$file") ($SIZE)"
done

log_info ""

# Ask for confirmation
read -p "Delete these log files? (y/n): " -r CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    log_warning "Cancelled"
    exit 0
fi

# Delete log files
DELETED=0
FAILED=0

find "$LOGS_DIR" -type f -name "*.log" 2>/dev/null | while read file; do
    if rm "$file" 2>/dev/null; then
        ((DELETED++))
    else
        ((FAILED++))
        log_warning "Failed to delete: $(basename "$file")"
    fi
done

# Re-count to confirm
REMAINING=$(find "$LOGS_DIR" -type f -name "*.log" 2>/dev/null | wc -l)

log_info "=========================================="
if [ "$REMAINING" -eq 0 ]; then
    log_success "All log files cleared!"
    log_info "Total deleted: $LOG_COUNT"
else
    log_warning "Cleanup incomplete. Remaining log files: $REMAINING"
fi
log_info "=========================================="

exit 0
