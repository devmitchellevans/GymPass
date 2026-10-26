/**
 * npm run key          show the current access key
 * npm run key -- --new create a new key (every device will be asked for it again)
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(__dirname, '..', 'data');
const keyFile = path.join(dataDir, 'access-key.txt');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

if (process.env.GYMPASS_ACCESS_KEY) {
  console.log(`Access key (from GYMPASS_ACCESS_KEY): ${process.env.GYMPASS_ACCESS_KEY.trim().toUpperCase()}`);
  process.exit(0);
}

if (process.argv.includes('--new') || !fs.existsSync(keyFile)) {
  fs.mkdirSync(dataDir, { recursive: true });
  const chars = Array.from(crypto.randomBytes(12), (b) => ALPHABET[b % ALPHABET.length]);
  const key = [0, 4, 8].map((i) => chars.slice(i, i + 4).join('')).join('-');
  fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  console.log(`New access key: ${key}\nRestart the server (npm run demo) so it takes effect.`);
} else {
  console.log(`Access key: ${fs.readFileSync(keyFile, 'utf8').trim()}`);
}
