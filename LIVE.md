Live / sensitive data
---------------------

This repository maintains a clear separation between test scripts and runtime/sensitive data.

- Tests live under `tests/` and should be safe / non-sensitive for CI usage.
- Sensitive runtime configuration (encrypted account keys, etc.) belongs in `profiles/` — this
  directory is listed in `.gitignore` so secrets won't be committed by mistake.

How to prepare live data:

1. Use `node modules/account_keys.js` interactively to create or manage encrypted key data; by default, the script writes sensitive information to `profiles/keys.json`, which is ignored.
2. To quickly bootstrap your local `profiles/` from the tracked examples in `examples/` (safe defaults), run:

```bash
Creates profiles/*.json from example templates when missing
npm run bootstrap:profiles

# non-destructive (shows what would be copied)
npm run bootstrap:profiles -- --dry

# overwrite any existing profiles files
npm run bootstrap:profiles -- --force
```
Note: the script will validate example JSON and will not overwrite live files unless --force is given.
2. Keep any other secrets (bots.json, etc.) in `profiles/` and ensure `.gitignore` includes them.

Configuration templates live under `examples/` — for example `examples/keys.json`.
