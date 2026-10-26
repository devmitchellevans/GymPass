/**
 * Creates a locally-trusted HTTPS certificate for the GymPass demo server using mkcert.
 * Phones/tablets only enable install, offline mode and the camera on HTTPS (or localhost),
 * so this is what makes http://<pc-ip> style access work as a real PWA.
 *
 *   npm run setup:https
 */
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const certDir = path.join(__dirname, '..', 'certs');
fs.mkdirSync(certDir, { recursive: true });

const probe = spawnSync('mkcert', ['-version'], { encoding: 'utf8', shell: process.platform === 'win32' });
if (probe.error || probe.status !== 0) {
  console.error(`mkcert is not installed (or not on PATH). Install it once, then re-run this script:

  Windows : winget install FiloSottile.mkcert      (or: choco install mkcert)
  macOS   : brew install mkcert
  Linux   : https://github.com/FiloSottile/mkcert#installation

Prefer no certificates? Use a tunnel instead: see OFFLINE.md ("Option B").`);
  process.exit(1);
}

const hosts = new Set(['localhost', '127.0.0.1', '::1', os.hostname()]);
for (const list of Object.values(os.networkInterfaces())) {
  for (const net of list ?? []) {
    if (net.family === 'IPv4' && !net.internal) hosts.add(net.address);
  }
}
for (const extra of process.argv.slice(2)) hosts.add(extra);

const run = (args) => execFileSync('mkcert', args, { stdio: 'inherit', shell: process.platform === 'win32' });

console.log('Installing the local CA on this PC (may prompt for admin rights)…');
run(['-install']);

console.log(`Creating a certificate for: ${[...hosts].join(', ')}`);
run(['-key-file', path.join(certDir, 'key.pem'), '-cert-file', path.join(certDir, 'cert.pem'), ...hosts]);

const caRoot = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
fs.copyFileSync(path.join(caRoot, 'rootCA.pem'), path.join(certDir, 'rootCA.pem'));

console.log(`
Done. Certificate files are in certs/ (git-ignored).

Next:
  1. npm run demo
  2. On each phone/tablet, once: open  http://<this-pc-ip>:3000/rootCA.pem  and install it as a trusted CA
     (iOS: Settings > General > VPN & Device Management, then Settings > General > About > Certificate Trust Settings).
  3. Then open  https://<this-pc-ip>:3443  and choose "Install app" / "Add to Home Screen".

If your PC's Wi-Fi IP changes, re-run this script.`);
