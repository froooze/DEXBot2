#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Clean up temporary files that can interfere with module loading
 * Removes .tmp.* files from modules and other directories
 */

function cleanupTempFiles() {
    const rootDir = path.join(__dirname, '..');
    const directoriesToClean = [
        rootDir, // Root directory
        path.join(rootDir, 'modules'),
        path.join(rootDir, 'modules', 'order'),
        path.join(rootDir, 'profiles'),
    ];

    let totalDeleted = 0;
    const deletedFiles = [];

    directoriesToClean.forEach(dir => {
        if (!fs.existsSync(dir)) return;

        try {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                // Match patterns like: filename.js.tmp.12345.1234567890
                if (file.includes('.tmp.')) {
                    const filePath = path.join(dir, file);
                    try {
                        fs.unlinkSync(filePath);
                        totalDeleted++;
                        deletedFiles.push(filePath);
                        console.log(`✓ Deleted: ${filePath}`);
                    } catch (err) {
                        console.error(`✗ Failed to delete ${filePath}: ${err.message}`);
                    }
                }
            });
        } catch (err) {
            console.error(`Error reading directory ${dir}: ${err.message}`);
        }
    });

    console.log(`\n✓ Cleanup complete. Deleted ${totalDeleted} temporary file(s).`);

    if (totalDeleted === 0) {
        console.log('No temporary files found.');
    }

    return totalDeleted;
}

// Run cleanup
try {
    cleanupTempFiles();
    process.exit(0);
} catch (err) {
    console.error(`Cleanup failed: ${err.message}`);
    process.exit(1);
}
