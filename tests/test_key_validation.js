const bs58check = require('bs58check').default || require('bs58check');
const { validatePrivateKey } = require('../modules/account_keys');

// Generate valid WIFs programmatically so tests don't rely on magic constants
const payloadUncompressed = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(32, 0x01)]);
const wifUncompressed = bs58check.encode(payloadUncompressed);

const payloadCompressed = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(32, 0x02), Buffer.from([0x01])]);
const wifCompressed = bs58check.encode(payloadCompressed);

const samples = {
    'valid_wif_uncompressed': wifUncompressed,
    'valid_wif_compressed': wifCompressed,
    'valid_pvt_k1': 'PVT_K1_123abcDEF',
    'valid_hex': 'a'.repeat(64),
    'invalid_short': '1234',
    'invalid_chars': '0OIl!@#$%'
};

for (const [name, s] of Object.entries(samples)) {
    const out = validatePrivateKey(s);
    console.log(name, s.length, out);
}
