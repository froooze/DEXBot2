Tests in this folder are intended to be non-sensitive and safe to run in CI. They include:

- `test_key_validation.js` - key format validation unit tests
- `test_privatekey_sanitize.js` - sanitization checks for pasted private keys

Interactive tests (e.g., `test_account_selection.js`, `test_fills.js`, `connection_test.js`) may require
runtime credentials and network connectivity and are therefore interactive by design. They should not contain
profiles secrets in the repository. Keep any sensitive test data in `profiles/` (which is git-ignored).

The project keeps safe example configs under `examples/` (e.g. `examples/keys.json`). For runtime testing, create
`profiles/keys.json` with your real encrypted data; `modules/account_keys.js` and `modules/account_orders.js`
prefer the profiles file if present.

You can quickly bootstrap a local `profiles/` from the tracked `examples/` files with:

```bash
npm run bootstrap:profiles
```
