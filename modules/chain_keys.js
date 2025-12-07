/**
 * Chain Keys Module - Authentication and encrypted private key storage
 * 
 * This module provides authentication and secure storage for BitShares private keys:
 * - Master password authentication with SHA-256 hash verification
 * - AES-256-GCM encryption with random salt and IV
 * - Private key retrieval for transaction signing
 * - Interactive CLI for key management (add/modify/remove)
 * 
 * Storage location: profiles/keys.json (gitignored)
 * 
 * Supported key formats:
 * - WIF (Wallet Import Format): 51-52 character Base58Check encoded
 * - PVT_K1_* style keys used by some Graphene chains
 * - Raw 64-character hexadecimal private keys
 * 
 * Security note: The master password is never stored; only its hash is kept
 * for verification. All private keys are encrypted before storage.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readlineSync = require('readline-sync');

/**
 * Securely read a password from stdin with asterisk masking.
 * Handles backspace and supports pasted text.
 * @param {string} prompt - Text to display before input
 * @returns {Promise<string>} The entered password
 */
function readPassword(prompt) {
    const stdin = process.stdin;
    const stdout = process.stdout;

    let password = '';

    // write prompt and prepare TTY/raw if possible
    stdout.write('\r\x1b[K' + prompt);

    if (stdin.isTTY) {
        stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding('utf8');

    return new Promise((resolve) => {
        // cleanup restores terminal and removes listener
        const cleanup = () => {
            try { stdin.removeListener('data', onData); } catch (e) { }
            try { if (stdin.isTTY) stdin.setRawMode(false); } catch (e) { }
            try { stdin.pause(); } catch (e) { }
        };

        // onData iterates through chunk characters so pasted text is handled correctly
        const onData = (chunk) => {
            const s = String(chunk);
            for (let i = 0; i < s.length; i++) {
                const ch = s[i];
                if (ch === '\r' || ch === '\n' || ch === '\u0004') {
                    cleanup();
                    stdout.write('\n');
                    return resolve(password);
                }

                if (ch === '\u0003') { // Ctrl+C
                    cleanup();
                    return process.exit();
                }

                // Backspace handling (both common codes)
                if (ch === '\u007f' || ch === '\u0008') {
                    if (password.length > 0) password = password.slice(0, -1);
                    stdout.write('\r\x1b[K' + prompt + '*'.repeat(password.length));
                    continue;
                }

                // Handle Delete key escape sequence (\x1b[3~)
                if (ch === '\x1b') {
                    // Peek ahead purely for Delete sequence detection if possible, or just wait for next chars buffer
                    // Since specific buffering is hard in this loop, we track state or just checking if next chars match
                    // For simplicity in this raw loop, we might need a small state machine or just read ahead if we can.
                    // A simpler way for this specific loop is to check if we have enough length remaining in `s` for [3~
                    // But `s` is a chunk.
                    // Given the constraint, let's just handle it if it comes in one chunk or handle individual chars if we track state.
                    // Actually, often arrow keys/delete come as a burst.
                    if (i + 3 < s.length && s[i + 1] === '[' && s[i + 2] === '3' && s[i + 3] === '~') {
                        if (password.length > 0) password = password.slice(0, -1);
                        stdout.write('\r\x1b[K' + prompt + '*'.repeat(password.length));
                        i += 3; // Skip the sequence
                        continue;
                    }
                }

                // Accept typical printable characters for keys (avoid newlines/control)
                const code = ch.charCodeAt(0);
                if (code >= 32 && code <= 126 && ch !== '\t') {
                    password += ch;
                    stdout.write('\r\x1b[K' + prompt + '*'.repeat(password.length));
                }
            }
        };

        stdin.on('data', onData);
    });
}

// Profiles key file (ignored) only
const PROFILES_KEYS_FILE = path.join(__dirname, '..', 'profiles', 'keys.json');

function ensureProfilesKeysDirectory() {
    const dir = path.dirname(PROFILES_KEYS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Encrypt text using AES-256-GCM with random salt and IV.
 * Returns a colon-separated string: salt:iv:authTag:ciphertext
 * @param {string} text - Plain text to encrypt
 * @param {string} password - Encryption password
 * @returns {string} Encrypted data as hex string
 */
function encrypt(text, password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return salt.toString('hex') + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt text encrypted with the encrypt() function.
 * @param {string} encrypted - Colon-separated encrypted data
 * @param {string} password - Decryption password
 * @returns {string} Decrypted plain text
 * @throws {Error} If decryption fails (wrong password or corrupted data)
 */
function decrypt(encrypted, password) {
    const parts = encrypted.split(':');
    const salt = Buffer.from(parts[0], 'hex');
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encryptedText = parts[3];
    const key = crypto.scryptSync(password, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

const bs58check = require('bs58check').default || require('bs58check');

/**
 * Validate a private key format.
 * Supports WIF (Base58Check), PVT_K1_* style, and 64-char hex.
 * @param {string} key - Private key to validate
 * @returns {Object} { valid: boolean, reason?: string }
 */
function validatePrivateKey(key) {
    if (!key || typeof key !== 'string') return { valid: false, reason: 'Empty key' };
    const k = key.trim();

    // Basic characters allowed for base58-like / ASCII keys
    const base58chars = /^[1-9A-HJ-NP-Za-km-z]+$/;

    // Strict WIF validation using base58check decode (verifies checksum & structure)
    try {
        // bs58check will throw if checksum invalid
        const payload = bs58check.decode(k);
        // WIFs for Bitcoin-style keys use 0x80 version byte and payload lengths 33 or 34
        // Uncompressed WIF payload: [0x80 | 32-byte privkey]
        // Compressed WIF payload: [0x80 | 32-byte privkey | 0x01]
        if (payload && payload.length >= 33) {
            // version is first byte
            const version = payload[0];
            if (version === 0x80) {
                // valid WIF format
                // payload length 33 (no compression byte) => uncompressed, 34 => compressed
                if (payload.length === 33 || payload.length === 34) {
                    return { valid: true };
                }
            }
        }
    } catch (err) {
        // Not a valid base58check WIF; continue to other formats
    }

    // PVT-style private key used by some Graphene-based chains (e.g. PVT_K1_<data>)
    // Example shape: PVT_K1_base58...
    if (/^PVT_(?:K1_)?[A-Za-z0-9_-]+$/.test(k)) {
        return { valid: true };
    }

    // Hex private key (64 hex chars) - accept optionally
    if (/^[0-9a-fA-F]{64}$/.test(k)) {
        return { valid: true };
    }

    return { valid: false, reason: 'Unrecognized key format' };
}

/**
 * Load stored accounts from profiles/keys.json.
 * Returns empty structure if file doesn't exist or is corrupted.
 * @returns {Object} { masterPasswordHash: string, accounts: Object }
 */
function loadAccounts() {
    try {
        if (!fs.existsSync(PROFILES_KEYS_FILE)) {
            return { masterPasswordHash: '', accounts: {} };
        }
        const content = fs.readFileSync(PROFILES_KEYS_FILE, 'utf8').trim();
        if (!content) {
            return { masterPasswordHash: '', accounts: {} };
        }
        return JSON.parse(content);
    } catch (error) {
        console.error('Error loading accounts file, resetting to default:', error.message);
        return { masterPasswordHash: '', accounts: {} };
    }
}
/**
 * Hash a password using SHA-256 for storage/comparison.
 * @param {string} password - Password to hash
 * @returns {string} Hex-encoded hash
 */
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}
class MasterPasswordError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MasterPasswordError';
        this.code = 'MASTER_PASSWORD_FAILED';
    }
}

const MASTER_PASSWORD_MAX_ATTEMPTS = 3;
let masterPasswordAttempts = 0;

async function _promptPassword() {
    if (masterPasswordAttempts >= MASTER_PASSWORD_MAX_ATTEMPTS) {
        throw new MasterPasswordError(`Incorrect master password after ${MASTER_PASSWORD_MAX_ATTEMPTS} attempts.`);
    }
    masterPasswordAttempts += 1;
    // Use readPassword instead of readlineSync to support Delete key and consistent masking
    return await readPassword('Enter master password: ');
}

/**
 * Authenticate and return the master password.
 * Prompts user interactively with limited retry attempts.
 * @returns {Promise<string>} The verified master password
 * @throws {Error} If no master password is set
 * @throws {MasterPasswordError} If max attempts exceeded
 */
async function authenticate() {
    const accountsData = loadAccounts();
    if (!accountsData.masterPasswordHash) {
        throw new Error('No master password set. Please run modules/chain_keys.js first.');
    }

    while (true) {
        const enteredPassword = await _promptPassword();
        if (hashPassword(enteredPassword) === accountsData.masterPasswordHash) {
            masterPasswordAttempts = 0;
            return enteredPassword;
        }
        if (masterPasswordAttempts < MASTER_PASSWORD_MAX_ATTEMPTS) {
            console.log('Master password not correct. Please try again.');
        }
    }
}

/**
 * Retrieve and decrypt a stored private key.
 * @param {string} accountName - Name of the account
 * @param {string} masterPassword - Master password for decryption
 * @returns {string} Decrypted private key
 * @throws {Error} If account not found
 */
function getPrivateKey(accountName, masterPassword) {
    const accountsData = loadAccounts();
    const account = accountsData.accounts[accountName];
    if (!account) {
        throw new Error(`Account '${accountName}' not found.`);
    }
    return decrypt(account.encryptedKey, masterPassword);
}
/**
 * Display stored account names to console.
 * @param {Object} accounts - Accounts object from loadAccounts()
 * @returns {Array<string>} Array of account names
 */
function listKeyNames(accounts) {
    if (!accounts || Object.keys(accounts).length === 0) {
        console.log('  (no accounts stored yet)');
        return [];
    }
    console.log('Stored keys:');
    return Object.keys(accounts).map((name, index) => {
        console.log(`  ${index + 1}. ${name}`);
        return name;
    });
}

function selectKeyName(accounts, promptText) {
    const names = Object.keys(accounts);
    if (!names.length) {
        console.log('No accounts available to select.');
        return null;
    }
    names.forEach((name, index) => console.log(`  ${index + 1}. ${name}`));
    const raw = readlineSync.question(`${promptText} [1-${names.length}]: `).trim();
    const idx = Number(raw) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= names.length) {
        console.log('Invalid selection.');
        return null;
    }
    return names[idx];
}

async function changeMasterPassword(accountsData, currentPassword) {
    if (!accountsData.masterPasswordHash) {
        console.log('No master password is set yet.');
        return currentPassword;
    }
    const oldPassword = await readPassword('Enter current master password:   ');
    if (hashPassword(oldPassword) !== accountsData.masterPasswordHash) {
        console.log('Incorrect master password!');
        return currentPassword;
    }
    const newPassword = await readPassword('Enter new master password:   ');
    const confirmPassword = await readPassword('Confirm new master password: ');
    if (newPassword !== confirmPassword) {
        console.log('Passwords do not match!');
        return currentPassword;
    }
    if (!newPassword) {
        console.log('New master password cannot be empty.');
        return currentPassword;
    }

    const decryptedKeys = {};
    try {
        for (const [name, account] of Object.entries(accountsData.accounts)) {
            decryptedKeys[name] = decrypt(account.encryptedKey, oldPassword);
        }
    } catch (error) {
        console.log('Failed to decrypt stored keys with the current master password:', error.message);
        return currentPassword;
    }

    for (const [name, account] of Object.entries(accountsData.accounts)) {
        account.encryptedKey = encrypt(decryptedKeys[name], newPassword);
    }
    accountsData.masterPasswordHash = hashPassword(newPassword);
    saveAccounts(accountsData);
    console.log('Master password updated successfully.');
    return newPassword;
}

/**
 * Save accounts data to profiles/keys.json.
 * Creates directory if needed.
 * @param {Object} data - Accounts data to save
 */
function saveAccounts(data) {
    // Always save sensitive data to the live path (ignored by git)
    ensureProfilesKeysDirectory();
    fs.writeFileSync(PROFILES_KEYS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Launch the interactive key management CLI.
 * Provides menu for: add/modify/remove keys, test decryption,
 * change master password.
 */
async function main() {
    console.log('Chain Key Manager');
    console.log('========================');

    let accountsData = loadAccounts();
    let masterPassword = '';

    // Check if master password is set
    if (!accountsData.masterPasswordHash) {
        console.log('No master password set. Please set one:');
        const password1 = await readPassword('Enter master password:   ');
        const password2 = await readPassword('Confirm master password: ');
        if (password1 !== password2) {
            console.log('Passwords do not match!');
            return;
        }
        accountsData.masterPasswordHash = hashPassword(password1);
        saveAccounts(accountsData);
        masterPassword = password1;
        console.log('Master password set successfully.');
    } else {

        let attempts = 0;
        const maxAttempts = 3;
        while (true) {
            attempts++;
            // Match 'dexbot start' style: no attempt count in prompt
            const enteredPassword = await readPassword('Enter master password: ');
            if (hashPassword(enteredPassword) === accountsData.masterPasswordHash) {
                masterPassword = enteredPassword;
                console.log('Authenticated successfully.');
                break;
            }

            if (attempts >= maxAttempts) {
                // Match the error thrown by authenticate() but just log and return here since we are in main()
                console.log(`Incorrect master password after ${maxAttempts} attempts.`);
                return;
            }

            console.log('Master password not correct. Please try again.');
        }
    }

    while (true) {
        console.log('\nMenu:');
        console.log('1. Add key');
        console.log('2. Modify key');
        console.log('3. Remove key');
        console.log('4. List keys');
        console.log('5. Test decryption');
        console.log('6. Change master password');
        console.log('7. Exit');

        const choice = readlineSync.question('Choose an option: ');
        console.log('');

        if (choice === '1') {
            const accountName = readlineSync.question('Enter account name: ');
            const privateKeyRaw = await readPassword('Enter private key:   ');
            const privateKey = privateKeyRaw.replace(/\s+/g, '');

            const validation = validatePrivateKey(privateKey);
            if (!validation.valid) {
                console.log(`Invalid private key: ${validation.reason}`);
                console.log('Accepted formats: WIF (51/52 chars), PVT_* keys, or 64-hex');
                continue;
            }

            const encryptedKey = encrypt(privateKey, masterPassword);

            accountsData.accounts[accountName] = { encryptedKey };
            saveAccounts(accountsData);
            console.log(`Account '${accountName}' added successfully.`);
        } else if (choice === '2') {
            const accountName = selectKeyName(accountsData.accounts, 'Select key to modify');
            if (!accountName) continue;
            const privateKeyRaw = await readPassword('Enter private key:   ');
            const privateKey = privateKeyRaw.replace(/\s+/g, '');

            const validation = validatePrivateKey(privateKey);
            if (!validation.valid) {
                console.log(`Invalid private key: ${validation.reason}`);
                console.log('Accepted formats: WIF (51/52 chars), PVT_* keys, or 64-hex');
                continue;
            }

            const encryptedKey = encrypt(privateKey, masterPassword);
            accountsData.accounts[accountName] = { ...accountsData.accounts[accountName], encryptedKey };
            saveAccounts(accountsData);
            console.log(`Account '${accountName}' updated successfully.`);
        } else if (choice === '3') {
            const accountName = readlineSync.question('Enter key name to remove: ');
            if (accountsData.accounts[accountName]) {
                delete accountsData.accounts[accountName];
                saveAccounts(accountsData);
                console.log(`Account '${accountName}' removed successfully.`);
            } else {
                console.log('Account not found.');
            }
        } else if (choice === '4') {
            listKeyNames(accountsData.accounts);
        } else if (choice === '5') {
            const accountName = readlineSync.question('Enter key name to test: ');
            if (accountsData.accounts[accountName]) {
                try {
                    const decryptedKey = decrypt(accountsData.accounts[accountName].encryptedKey, masterPassword);
                    console.log(`First 5 characters: ${decryptedKey.substring(0, 5)}`);
                    decryptedKey.replace(/./g, ' ');
                } catch (error) {
                    console.log('Decryption failed - wrong master password or corrupted data');
                }
            } else {
                console.log('Account not found.');
            }
        } else if (choice === '6') {
            masterPassword = await changeMasterPassword(accountsData, masterPassword);
        } else if (choice === '7') {
            console.log('Goodbye!');
            break;
        } else {
            console.log('Invalid choice.');
        }
    }
}

module.exports = {
    validatePrivateKey,
    loadAccounts,
    saveAccounts,
    encrypt,
    decrypt,
    hashPassword,
    main,
    authenticate,
    getPrivateKey,
    MasterPasswordError,
};
