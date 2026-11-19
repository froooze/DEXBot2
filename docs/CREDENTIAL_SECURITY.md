# DEXBot2 Credential Security

## Overview

DEXBot2 keeps private keys out of the bot process entirely. A dedicated
**credential daemon** holds the vault secret in memory and serves signing
requests over a local socket. The bot uses a *signing token* to tell the daemon
which account to use; the daemon signs or broadcasts operations internally and
returns results. Raw private keys never leave the daemon process.

The full chain from user password to on-chain operation looks like this:

```
Master password
      │
      ▼ scrypt (N=2¹⁷, r=8, p=1)
  Vault key ──────────────────────────────┬── HMAC-SHA256 (vault verifier)
      │                                   │
      ▼ HKDF-SHA256 (per-record salt)     ▼
   Record key → AES-256-GCM → keys.json   timingSafeEqual on unlock
      │
      ▼ daemon startup
  Session secret (HKDF-SHA256, new random salt each run)
      │
      ▼ AES-256-GCM re-encrypt
  In-RAM session cache (encrypted entries)
      │
      ▼ signing token handed to bot
  Daemon signs/broadcasts  →  result returned to bot
```

---

## System Architecture

DEXBot2 implements a layered security model to protect private keys and
credentials at rest, in transit, and in RAM during a live session.

### Policy Engine & Strict Enforcement
The credential daemon enforces a strictly held **HMAC-SHA256** policy engine
(see §2 and §7). Every signing request is cryptographically validated against a
per-account `botHmacSecret` loaded from `daemon-policies.json`; the daemon
hot-reloads the policy on `SIGHUP` and via an `fs.watch` safety net, so bots
cannot bypass verification or hit unauthorized resource limits even after a
live policy edit.

### Session Management & Auto-Heal
The daemon supports persistent operations via session IDs. To mitigate
interruptions (e.g., a daemon policy reload, a daemon restart, or session TTL
expiration), the **bot** implements a transparent renegotiation loop: when an
`executeViaDaemonToken` call fails with a stale session or stale HMAC, the bot
fetches a new `sessionId`, injects it into the `signingToken`, optionally
signals the daemon to reload its policy via `SIGHUP`, and cleanly replays the
pending operations. (Full sequence in §2 — HMAC Session Recovery.)

### Daemon Policy & Batch Limits
The credential daemon enforces granular operation policies via `daemon-policies.json`.
These policies are strictly enforced at the daemon boundary. To prevent
resource exhaustion, the daemon enforces a global `maxOpsPerBatch` limit
(defaulting to 200). This ensures that complex grid replacements or
batch orders do not overwhelm the daemon's internal state.

### Memory Safety & Zeroing
To minimize the window of exposure for sensitive key material, the credential
daemon implements explicit memory scrubbing on a best-effort basis. Upon process
termination, the `shutdown()` handler iterates all sensitive objects (vault
secrets, session secrets, and cached account keys), calls `Buffer.fill(0)` on
any Buffer properties, and nulls all references. Hex-string key properties
(`vaultKeyHex`, `sessionSaltHex`) are immutable in V8 and cannot be zeroed
in place — they are dropped via reference nulling and reclaimed by the garbage
collector.

---

## 1. Key Storage — `keys.json` (vault v2)

### Password-to-key derivation

The master password is never stored. It is run through **scrypt** to produce a
32-byte *vault key*:

| Parameter | Value | Purpose |
|-----------|-------|---------|
| N         | 2¹⁷ (131 072) | Memory-hard work factor |
| r         | 8    | Block size |
| p         | 1    | Parallelism |
| dkLen     | 32 bytes | AES-256 key length |
| salt      | 16 random bytes, stored in vault | Prevents rainbow tables |
| maxmem    | 256 MB | Caps memory usage |

This makes offline brute-force attacks against a stolen `keys.json` expensive.

### Per-record key isolation (HKDF)

The vault key is **never used directly** to encrypt a private key. Each record
gets its own 16-byte random salt, and a record-specific key is derived via
**HKDF-SHA256**:

```
record key = HKDF-SHA256(
    ikm  = vault key,
    salt = random 16 bytes (stored with the record),
    info = "dexbot2:v2:record-key"
)
```

This means compromising one record key does not help an attacker decrypt any
other record.

### Encryption

Each private key is encrypted with **AES-256-GCM**:

- 12-byte random IV per encryption operation
- 16-byte GCM authentication tag (detects tampering)
- Stored format: `v2:<recordSalt>:<iv>:<authTag>:<ciphertext>` (all hex)

### Vault verifier (unlock check without storing the password)

A short **HMAC-SHA256** of a fixed label under the vault key is stored in
`keys.json`. On unlock, the candidate vault key is reproduced and its HMAC is
compared with **`crypto.timingSafeEqual`** to prevent timing attacks. If the
comparison fails, the wrong password was supplied — no key material is ever
decrypted.

---

## 2. Credential Daemon

The daemon (`credential-daemon.ts`) is a long-running local process that holds
the vault key and session cache in RAM. Callers communicate with it over a Unix
domain socket; the main signing flow never hands raw key bytes to the bot.

### Startup sequence

1. Launcher creates a **one-shot bootstrap socket** in a freshly created
   `mkdtemp` directory (chmod 0700) and writes the socket path to a stable
   **bootstrap path file** (`.dexbot-cred-bootstrap-path`, mode 0600) in the
   runtime directory.
2. The launcher passes `DEXBOT_CRED_BOOTSTRAP_PATH_FILE` (pointing to the
   path file) to the daemon child process — **not** the socket path directly.
   This prevents PM2 from persisting the one-shot socket path across restarts.
3. The daemon reads the env var, **immediately deletes it from `process.env`**,
   reads the path file, connects to the bootstrap socket, requests the secret,
   and deletes the path file from disk.
4. Once the secret is transferred the bootstrap server closes, the socket and
   temp directory are removed, and the bootstrap path becomes unreachable.
5. Daemon loads `keys.json` into memory, builds the session cache (see §3).
6. Daemon writes a *ready file* and begins accepting signing requests on the main
   socket. The bootstrap socket no longer exists at this point.

A configurable timeout (default: 60 seconds, `DAEMON_STARTUP_TIMEOUT_MS`)
aborts the entire bootstrap if the daemon does not connect in time, preventing
the bootstrap socket from being left open indefinitely.

### What the daemon exposes

| Request type          | What it does |
|-----------------------|-------------|
| `ping`                | Lightweight health check (no session created, no audit log entry) |
| `probe-account`       | Confirms an account is available and creates a session (no key material returned) |
| `execute-operations`  | Signs and broadcasts a batch; returns result |

The daemon **never** exports raw private keys. All signing happens internally;
callers receive only operation results.

### HMAC Session Recovery

When `executeViaDaemonToken` returns `SOURCE_AUTH_DENIED` (stale `botHmacSecret`)
or `SESSION_EXPIRED` (stale or missing `sessionId`) — e.g. after the daemon
reloaded its policy, after a daemon restart, or after a session TTL expiry —
the **bot** recovers transparently from `modules/key_store.ts`:

1. Bot detects the denied response and branches on the cause
   (`SOURCE_AUTH_DENIED` vs `SESSION_EXPIRED`).
2. For `SOURCE_AUTH_DENIED`, the bot reads the daemon ready file, extracts the
   daemon PID, and sends `SIGHUP` to the daemon to trigger a policy reload.
3. Bot fetches a fresh `sessionId` via `probe-account`.
4. Bot injects the new `sessionId` into the `signingToken`.
5. For `SOURCE_AUTH_DENIED` only, the bot sleeps 500ms so the daemon's
   `SIGHUP`/`fs.watch` policy reload settles before replaying; for a plain
   `SESSION_EXPIRED` no sleep is needed.
6. Bot replays the pending operation.

On the daemon side, `SIGHUP` only triggers a strict reload of
`daemon-policies.json` and a node-list refresh — it never restarts the process
or sleeps. This keeps the pipeline unblocked without operator intervention.

### Daemon signing token

The bot receives a **signing token** at startup:

```js
{
  kind: 'dexbot-daemon-signing-token',
  accountName: '<account>',
  socketPath: '/run/user/<uid>/dexbot2/dexbot-cred-daemon.sock',
  sessionId: '<hex session id, or null>',
  botHmacSecret: '<per-account HMAC secret, or null>'
}
```

This token carries no key material. If intercepted, an attacker can only submit
signing requests to the daemon for the named account while the daemon is running —
they cannot extract the private key.

---

## 3. Session Cache — Ephemeral Re-encryption

When the daemon starts, every account key is re-encrypted under a **session
secret** that is freshly randomized each run. This is the "temporary key"
mechanism:

```
session secret = HKDF-SHA256(
    ikm  = vault key,
    salt = random 16 bytes (generated at daemon start, never persisted),
    info = "dexbot2:v2:session-key"
)
```

All private keys are then re-encrypted with AES-256-GCM under this session
secret and stored in a `Map` in RAM. Consequences:

- **No plaintext keys are retained in the cache.** Decrypted keys exist only
  transiently while a request is being serviced, then are re-encrypted under
  the session secret.
- **Session isolation.** A memory snapshot from one run cannot be replayed into
  another because the session salt is never written to disk.
- **Vault fallback.** If `keys.json` is readable, the daemon always re-derives
  the key from disk on a cache miss, keeping the session cache fresh after key
  rotation or new account additions — without a restart.

---

## 4. Runtime File Security

The daemon communicates over a Unix domain socket. All runtime paths are
validated before use or before any stale path is removed.

### Directory

The runtime directory defaults to `$XDG_RUNTIME_DIR/dexbot2/` when
`$XDG_RUNTIME_DIR` is usable; otherwise it falls back to `run/` under the
**resolved profiles directory** (by default `~/.config/dexbot2/profiles/run`), never
inside the repository or package tree. In both cases it is created with mode **0700** (owner
read/write/execute only) and verified at every startup.

### Socket and ready file

Both the socket (`dexbot-cred-daemon.sock`) and the ready file
(`dexbot-cred-daemon.ready`) are chmod'd to **0600** after creation.

Before trusting or unlinking either path, the code asserts all of the following:

| Check | Requirement |
|-------|-------------|
| Symbolic link | Refused — `lstat` is used, not `stat` |
| File type | Must match expected type (`socket` or `file`) |
| Owner UID | Must match the current process UID |
| Permissions | Must be exactly `0600` |

A stale socket that fails any of these checks is not removed, preventing a
malicious process from placing a rogue socket at the expected path and having the
daemon silently unlink it and take over.

### Bootstrap directory cleanup

During stale bootstrap directory cleanup, the code additionally probes any
`bootstrap.sock` file found inside a temp directory with a short connection
attempt (`probeBootstrapSocket`, 300ms timeout). If the connection succeeds,
the socket is live and its parent directory is preserved — even if the directory
mtime suggests it is stale. This prevents accidentally removing a bootstrap
directory that is actively being used by a concurrent launcher.

---

## 5. Authentication Failure Handling

Interactive master-password attempts are capped at **3**. Once the budget is
exhausted:

- An unambiguous PM2-compatible error message is printed.
- The process exits immediately.
- No partial state is left behind.

The failure path is consistent regardless of whether the daemon or the
interactive password prompt handled the authentication, making the output
predictable for monitoring and alerting.

### Cancelling the key manager (Escape ≠ wrong password)

Pressing **Escape** at any interactive key-manager prompt is an explicit
*cancellation*, never a failed authentication. The contract:

- `authenticate()` throws `MasterPasswordCancelledError` on Escape
  (`modules/chain_keys.ts`). `isMasterPasswordFailure()` recognizes
  cancellation alongside a genuinely wrong password, so every abort path
  (`key_store`, `chain_orders`, `credential_daemon`, `dexbot_class`, `dexbot`)
  handles it without reporting it as an authentication failure.
- `main()` returns whether a **usable vault** exists, routes every close through
  one message, keeps submenu Escape local to the operation, and
  `selectKeyName()` returns `null` on cancel. `dexbot.ts` honors that return
  value and surfaces a cancellation message during first-run setup.
- **Setup completeness is a usable account entry, not password metadata.**
  `hasKeySetup()` requires a valid `v2` encrypted key, so `dexbot start` routes
  back into onboarding instead of launching with a vault that cannot sign
  (`selectStartOnboardingCommand(hasKeySetup, botCount)`: no usable key → `key`;
  key but no bot definitions → `bot`; otherwise launch).
- Non-interactive launches never block on a prompt: `--headless` / `--dryrun`
  with incomplete configuration fail fast with a message. Programmatic
  `unlock.main()` callers (tests, embeds) get no onboarding at all.

Cancellation leaves no secret material behind: it is a read-only abort of the
prompt, and the 3-attempt cap applies only to real password attempts.

---

## 6. Startup Path — Daemon-First, Interactive Fallback

```
bot.ts / dexbot.ts
      │
      ▼ probe daemon (probe-account)
  Daemon healthy?
  ├── YES  →  obtain signing token  →  start bot with token
  └── NO   →  fall back to interactive master-password prompt
                    │
                    ▼ attempts exhausted?
                YES  →  print failure message, exit
```

This means production deployments running the daemon never expose the master
password interactively, while the interactive path remains available for
development and recovery.

### Headless (Non-Interactive) Startup

For environments without an interactive TTY (Docker containers, PaaS platforms),
the launcher supports a `--headless` flag that reads the master password from a
non-interactive source instead of prompting:

```bash
# Via environment variable
DEXBOT_MASTER_PASSWORD=<password> node dist/unlock.js --headless

# Via secret file (recommended)
node dist/unlock.js --headless --password-file /run/secrets/bot-password
```

**Security considerations:**

| Source | Risk | Mitigation |
|--------|------|------------|
| `DEXBOT_MASTER_PASSWORD` env var | Password visible in `/proc/<pid>/environ` and process listings | Use only in ephemeral containers; prefer `--password-file` |
| `--password-file <path>` | File permissions may leak the password | Set file to `chmod 400` and use Docker secrets or `tmpfs` mounts |

In both cases, the password is used immediately to derive the vault key via
`chainKeys.unlockWithPassword()` and is **not** retained in memory beyond the
unlock call. The derived vault secret is passed to the credential daemon through
the same one-shot bootstrap socket mechanism described in §2.

**When to use headless mode:**
- Docker/PaaS deployments where stdin is not a TTY
- Automated restart scripts that cannot provide interactive input
- CI/CD test pipelines that need a pre-configured key vault

**When to avoid it:**
- Shared or multi-tenant environments where `/proc` is accessible
- Any deployment where the operator cannot control filesystem permissions
  on the password file

The foreign daemon detection and cleanup logic runs identically in both
interactive and headless modes.

### Foreign Daemon Detection

At startup, `unlock` scans for credential daemons left by a different user or a
stale session. If a foreign daemon is found (wrong UID or mismatched runtime
directory):

- The foreign daemon is gracefully terminated.
- Its socket, ready file, and runtime artifacts are cleaned up.
- A fresh daemon is started under the correct user context.

This prevents credential cross-contamination when switching between user
accounts or after an unclean exit.

---

## 7. Summary of Techniques

| Technique | Where applied | Purpose |
|-----------|--------------|---------|
| scrypt (N=2¹⁷) | Password → vault key | Memory-hard KDF; resists brute force |
| HKDF-SHA256 (per-record) | Vault key → record key | Key isolation per account |
| HKDF-SHA256 (random salt) | Vault key → session key | Ephemeral RAM-only re-encryption |
| AES-256-GCM | All encryption operations | Authenticated encryption; detects tampering |
| HMAC-SHA256 | Vault verifier | Unlock check without storing the password |
| `crypto.timingSafeEqual` | Verifier comparison | Prevents timing-based password oracle |
| Batch limit (200) | `execute-operations` | Prevents resource exhaustion |
| Signing token (no key export) | Bot ↔ daemon IPC | Private key never leaves daemon boundary; raw key export removed |
| `lstat` + owner/mode/type checks | Runtime socket & ready file | Prevents symlink attacks and rogue sockets |
| 0700 runtime dir / 0600 sockets | Filesystem | OS-level access restriction |
| Random session salt (not persisted) | Session cache | Memory snapshot from one run is useless in another |
| One-shot bootstrap socket (mkdtemp 0700, auto-cleanup) | Secret handoff to daemon | Secret is never written to disk; socket destroyed after first use |
| `probeBootstrapSocket` (live probe before cleanup) | Bootstrap dir cleanup | Prevents removing a live bootstrap directory |
| `delete process.env.DEXBOT_CRED_BOOTSTRAP_PATH_FILE` | Daemon startup | Bootstrap path cannot be inherited by child processes or read from /proc |
| Attempt limit (3) + immediate exit | Interactive auth | Limits online brute-force window |

---

### 8. Multi-sig / Authority Delegation

The credential daemon can sign for accounts that are not directly stored in
`keys.json` by walking on-chain authority structures. This is an **intended
feature** of the authority resolver (`modules/authority_resolver.ts`), but it
has security implications that every operator should understand.

#### How it works

When a signing request arrives for an account with no direct key in the vault,
`resolvePrivateKey` fetches the account's active authority from the chain and
checks:

1. **Direct key lookup** — does `keys.json` have a key for this account?
2. **`account_auths`** — does another account (referenced in the active
   authority, recursive up to depth 2) have a stored key whose weight
   individually meets the threshold?
3. **`key_auths`** — does any stored private key produce a public key that
   matches an entry in the key auth list (again, weight must individually meet
   the threshold)?

#### Blast radius

If you store **account A**'s key, and **account B** lists A (or A's key) in its
`account_auths` / `key_auths` with sufficient weight:

- The daemon can sign operations for **account B** even though B's key was never
  added to `keys.json`.
- This also applies transitively: if B is in C's `account_auths`, the daemon
  can sign for C (depth ≤ 2).
- The same HMAC session / policy enforcement rules apply to these
  authority-resolved accounts.

#### Limitations

- Only single-authority entries whose individual weight meets the full
  `weight_threshold` are supported. BitShares multi-signature (combining
  multiple entries to cross the threshold) is **not** supported and produces
  an explicit error.
- Recursion is capped at depth 2 to prevent infinite loops from cyclic
  authority graphs.

#### Operational guidance

- Review the `account_auths` and `key_auths` of all accounts that have keys
  in your vault, and of accounts they reference. A stored key may grant signing
  authority to accounts you did not expect.
- If you want to restrict which accounts the daemon can sign for, enforce this
  at the policy layer (`daemon-policies.json` per-account policies) rather than
  relying on key absence.
- Removing an account from `keys.json` does **not** revoke authority if another
  stored key still reaches the account through `account_auths` or `key_auths`.
  Consider the full authority graph when rotating keys.
