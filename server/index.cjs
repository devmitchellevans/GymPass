const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

// Optional .env file (KEY=VALUE per line) so email settings can live in one file instead of
// having to set environment variables by hand. Real environment variables always win.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !line.trim().startsWith('#') && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const certDir = process.env.GYMPASS_CERT_DIR || path.join(__dirname, '..', 'certs');
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------------------------
// Access key. Every /api route except /api/health requires it (header: X-GymPass-Key).
// Source order: GYMPASS_ACCESS_KEY env var -> data/access-key.txt -> generated on first run.
// ---------------------------------------------------------------------------------------------
const keyFile = path.join(dataDir, 'access-key.txt');
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I so it is easy to read out loud

function generateAccessKey() {
  const bytes = crypto.randomBytes(12);
  const chars = Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join('')).join('-');
}

function normalizeKey(value) {
  return String(value ?? '').trim().toUpperCase();
}

function loadAccessKey() {
  if (process.env.GYMPASS_ACCESS_KEY) {
    return { key: normalizeKey(process.env.GYMPASS_ACCESS_KEY), source: 'GYMPASS_ACCESS_KEY environment variable' };
  }
  if (fs.existsSync(keyFile)) {
    const existing = normalizeKey(fs.readFileSync(keyFile, 'utf8'));
    if (existing) return { key: existing, source: keyFile };
  }
  const key = generateAccessKey();
  fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  return { key, source: keyFile };
}

const ACCESS = loadAccessKey();
const keyDigest = crypto.createHash('sha256').update(ACCESS.key).digest();

function keyMatches(candidate) {
  const digest = crypto.createHash('sha256').update(normalizeKey(candidate)).digest();
  return crypto.timingSafeEqual(digest, keyDigest); // constant-time compare
}

// Slow down guessing: 10 wrong keys from one address locks that address out for 10 minutes.
const failures = new Map();
const MAX_FAILURES = 10;
const LOCKOUT_MS = 10 * 60 * 1000;

function requireAccessKey(req, res, next) {
  const ip = req.socket.remoteAddress || 'unknown';
  const entry = failures.get(ip);
  if (entry && entry.count >= MAX_FAILURES && Date.now() - entry.last < LOCKOUT_MS) {
    return res.status(429).json({ error: 'Too many wrong keys. Try again in a few minutes.' });
  }
  if (keyMatches(req.get('x-gympass-key'))) {
    failures.delete(ip);
    return next();
  }
  failures.set(ip, { count: (entry && Date.now() - entry.last < LOCKOUT_MS ? entry.count : 0) + 1, last: Date.now() });
  return res.status(401).json({ error: 'Access key required.' });
}

const db = new Database(path.join(dataDir, 'gympass.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact_number TEXT NOT NULL,
    email TEXT NOT NULL,
    expires_on TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS check_ins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT NOT NULL,
    member_name TEXT NOT NULL,
    checked_in_at TEXT NOT NULL,
    membership_status TEXT NOT NULL CHECK (membership_status IN ('active', 'expired')),
    FOREIGN KEY (member_id) REFERENCES members(id)
  );
`);

// --- Offline-first sync migration (safe to run on an existing database) ---
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
// client_id makes check-in uploads idempotent: a retried sync can never create duplicates.
addColumnIfMissing('check_ins', 'client_id', 'TEXT');
addColumnIfMissing('check_ins', 'device_id', 'TEXT');
// Members can now be edited and deleted. updated_at drives "last edit wins" between devices;
// deleted is a soft delete (tombstone) so other devices learn about it and check-in history survives.
addColumnIfMissing('members', 'updated_at', 'TEXT');
addColumnIfMissing('members', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
db.exec('UPDATE members SET updated_at = created_at WHERE updated_at IS NULL');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_check_ins_client_id ON check_ins(client_id)');

const insertMember = db.prepare(`
  INSERT INTO members (id, name, contact_number, email, expires_on, created_at, updated_at)
  VALUES (@id, @name, @contactNumber, @email, @expiresOn, @createdAt, @createdAt)
`);
const getMember = db.prepare('SELECT * FROM members WHERE id = ?');
const listCheckIns = db.prepare(`
  SELECT id, member_id AS memberId, member_name AS memberName, checked_in_at AS checkedInAt,
         membership_status AS membershipStatus
  FROM check_ins
  ORDER BY datetime(checked_in_at) DESC, id DESC
  LIMIT 200
`);
const insertCheckIn = db.prepare(`
  INSERT INTO check_ins (member_id, member_name, checked_in_at, membership_status)
  VALUES (@memberId, @memberName, @checkedInAt, @membershipStatus)
`);

const insertSyncedMember = db.prepare(`
  INSERT INTO members (id, name, contact_number, email, expires_on, created_at, updated_at, deleted)
  VALUES (@id, @name, @contactNumber, @email, @expiresOn, @createdAt, @updatedAt, @deleted)
`);
const updateSyncedMember = db.prepare(`
  UPDATE members
  SET name = @name, contact_number = @contactNumber, email = @email, expires_on = @expiresOn,
      updated_at = @updatedAt, deleted = @deleted
  WHERE id = @id
`);
const insertSyncedCheckIn = db.prepare(`
  INSERT OR IGNORE INTO check_ins (member_id, member_name, checked_in_at, membership_status, client_id, device_id)
  VALUES (@memberId, @memberName, @checkedInAt, @membershipStatus, @clientId, @deviceId)
`);
const allMembers = db.prepare('SELECT * FROM members ORDER BY created_at');
const checkInsSince = db.prepare(`
  SELECT id, client_id AS clientId, member_id AS memberId, member_name AS memberName,
         checked_in_at AS checkedInAt, membership_status AS membershipStatus, device_id AS deviceId
  FROM check_ins
  WHERE id > ?
  ORDER BY id ASC
  LIMIT 1000
`);
const maxCheckInId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM check_ins');

function todayLocalDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function membershipStatus(expiresOn) {
  return expiresOn >= todayLocalDate() ? 'active' : 'expired';
}

function createMemberId() {
  return `GP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function mapMember(row) {
  return {
    id: row.id,
    name: row.name,
    contactNumber: row.contact_number,
    email: row.email,
    expiresOn: row.expires_on,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    deleted: Boolean(row.deleted),
    membershipStatus: membershipStatus(row.expires_on),
  };
}

async function qrDataUrl(memberId) {
  return QRCode.toDataURL(memberId, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
    color: { dark: '#10231c', light: '#ffffff' },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function mailTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST) {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Everything below this line needs the access key.
app.use('/api', requireAccessKey);

// Lets the app check a typed key without touching any data.
app.post('/api/auth/check', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/members', async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    const contactNumber = String(req.body?.contactNumber ?? '').trim();
    const email = String(req.body?.email ?? '').trim();
    const expiresOn = String(req.body?.expiresOn ?? '').trim();

    if (!name || !contactNumber || !email || !expiresOn) {
      return res.status(400).json({ error: 'Name, contact number, email, and membership expiry are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
      return res.status(400).json({ error: 'Expiry date must be YYYY-MM-DD.' });
    }

    let id = createMemberId();
    while (getMember.get(id)) {
      id = createMemberId();
    }

    const createdAt = new Date().toISOString();
    insertMember.run({ id, name, contactNumber, email, expiresOn, createdAt });
    const member = mapMember(getMember.get(id));
    const qrCode = await qrDataUrl(id);
    res.status(201).json({ member, qrCode });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not create member.' });
  }
});

app.get('/api/members/:id', (req, res) => {
  const row = getMember.get(req.params.id);
  if (!row || row.deleted) {
    return res.status(404).json({ error: 'Member not found.' });
  }
  res.json(mapMember(row));
});

app.post('/api/members/:id/email', async (req, res) => {
  try {
    const row = getMember.get(req.params.id);
    if (!row || row.deleted) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    const transport = mailTransport();
    if (!transport) {
      return res.status(503).json({
        error: 'Email server is not configured.',
        fallback: true,
      });
    }

    const member = mapMember(row);
    const qrCode = await qrDataUrl(member.id);
    const from = process.env.MAIL_FROM || process.env.SMTP_USER;
    const png = Buffer.from(qrCode.split(',')[1], 'base64');
    const safeName = escapeHtml(member.name);
    await transport.sendMail({
      from,
      to: member.email,
      subject: `Your GymPass QR — ${member.id}`,
      text: `Hi ${member.name},\n\nYour GymPass member ID is ${member.id}. The QR code is attached to this email (${member.id}.png). Present it at the gym to check in.\nMembership expires on ${member.expiresOn}.\n`,
      html: `<p>Hi ${safeName},</p><p>Your GymPass member ID is <strong>${escapeHtml(member.id)}</strong>. Present this QR code at the gym to check in. The image is also attached to this email as <em>${escapeHtml(member.id)}.png</em>.</p><p>Membership expires on ${escapeHtml(member.expiresOn)}.</p><p><img src="cid:gympass-qr" alt="GymPass QR" width="240" height="240" /></p>`,
      attachments: [
        // Shown inside the email body...
        { filename: `${member.id}.png`, content: png, contentType: 'image/png', cid: 'gympass-qr', contentDisposition: 'inline' },
        // ...and also attached as a normal file the member can save or forward.
        { filename: `GymPass-${member.id}.png`, content: png, contentType: 'image/png', contentDisposition: 'attachment' },
      ],
    });

    res.json({ sent: true });
  } catch (error) {
    console.error(error);
    // Tell the person what to fix, without leaking server details.
    let reason = 'The server could not send the email.';
    if (error && error.code === 'EAUTH') {
      reason = 'The email account refused the login. For Gmail, use an App password (see OFFLINE.md).';
    } else if (error && ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ENOTFOUND', 'ECONNREFUSED'].includes(error.code)) {
      reason = 'The server could not reach the email provider. Check its internet connection and SMTP_HOST / SMTP_PORT.';
    } else if (error && error.responseCode >= 500) {
      reason = 'The email provider rejected the message.';
    }
    res.status(502).json({ error: reason });
  }
});


const ID_RE = /^GP-[0-9A-F]{8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Offline-first sync.
 * Request : { deviceId, since, members: [...new local members], checkIns: [...new local check-ins] }
 * Response: { accepted, rejected, members: [all], checkIns: [id > since], cursor, hasMore, serverTime }
 * Every upload is idempotent (INSERT OR IGNORE on member id / check-in client_id), so retries are safe.
 */
const applySync = db.transaction((deviceId, members, checkIns) => {
  const rejected = [];
  let accepted = 0;

  for (const m of members) {
    const id = String(m?.id ?? '').trim().toUpperCase();
    const name = String(m?.name ?? '').trim();
    const contactNumber = String(m?.contactNumber ?? '').trim();
    const email = String(m?.email ?? '').trim();
    const expiresOn = String(m?.expiresOn ?? '').trim();
    const createdAt = String(m?.createdAt ?? '') || new Date().toISOString();
    if (!ID_RE.test(id) || !name || !contactNumber || !EMAIL_RE.test(email) || !DATE_RE.test(expiresOn)) {
      rejected.push({ kind: 'member', key: id || '?', reason: 'Invalid member data.' });
      continue;
    }

    // "Last edit wins". A device with a wrong clock must not be able to win forever,
    // so an edit time in the future is clamped to now.
    let editedAt = Date.parse(String(m?.updatedAt ?? ''));
    if (Number.isNaN(editedAt)) editedAt = Date.parse(createdAt) || Date.now();
    editedAt = Math.min(editedAt, Date.now());
    const incoming = {
      id, name, contactNumber, email, expiresOn,
      updatedAt: new Date(editedAt).toISOString(),
      deleted: m?.deleted ? 1 : 0,
    };

    const existing = getMember.get(id);
    if (!existing) {
      insertSyncedMember.run({ ...incoming, createdAt });
    } else if (existing.created_at !== createdAt) {
      // Same ID but a different member record: a (very unlikely) ID collision between two devices.
      rejected.push({ kind: 'member', key: id, reason: 'Member ID already belongs to someone else.' });
      continue;
    } else if (editedAt >= Date.parse(existing.updated_at || existing.created_at)) {
      updateSyncedMember.run(incoming);
    }
    // else: the server already has a newer edit. Not an error: the device receives the newer copy below.
    accepted++;
  }

  for (const c of checkIns) {
    const clientId = String(c?.clientId ?? '').trim();
    const memberId = String(c?.memberId ?? '').trim().toUpperCase();
    const checkedInAt = String(c?.checkedInAt ?? '');
    const status = c?.membershipStatus === 'expired' ? 'expired' : 'active';
    const member = getMember.get(memberId);
    if (!clientId || Number.isNaN(Date.parse(checkedInAt))) {
      rejected.push({ kind: 'checkIn', key: clientId || '?', reason: 'Invalid check-in data.' });
      continue;
    }
    if (!member) {
      rejected.push({ kind: 'checkIn', key: clientId, reason: `Unknown member ${memberId}.` });
      continue;
    }
    insertSyncedCheckIn.run({
      memberId,
      memberName: member.name,
      checkedInAt: new Date(checkedInAt).toISOString(),
      membershipStatus: status,
      clientId,
      deviceId: deviceId || null,
    });
    accepted++;
  }
  return { accepted, rejected };
});

app.post('/api/sync', (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId ?? '').slice(0, 64);
    const since = Number(req.body?.since) || 0;
    const members = Array.isArray(req.body?.members) ? req.body.members.slice(0, 2000) : [];
    const checkIns = Array.isArray(req.body?.checkIns) ? req.body.checkIns.slice(0, 5000) : [];

    const { accepted, rejected } = applySync(deviceId, members, checkIns);

    const rows = checkInsSince.all(since).map((r) => ({ ...r, clientId: r.clientId || `srv-${r.id}` }));
    const cursor = rows.length ? rows[rows.length - 1].id : since;
    res.json({
      accepted,
      rejected,
      members: allMembers.all().map(mapMember),
      checkIns: rows,
      cursor,
      hasMore: cursor < maxCheckInId.get().id,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Sync failed.' });
  }
});

app.get('/api/server-info', (_req, res) => {
  res.json({ urls: lanUrls(), https: Boolean(tlsOptions()) });
});

// Lets phones download the mkcert root CA (only when the owner placed it in certs/).
app.get('/rootCA.pem', (_req, res) => {
  const ca = path.join(certDir, 'rootCA.pem');
  if (!fs.existsSync(ca)) {
    return res.status(404).send('No rootCA.pem in certs/.');
  }
  res.type('application/x-pem-file').download(ca, 'GymPass-rootCA.pem');
});

app.get('/api/check-ins', (_req, res) => {
  res.json(listCheckIns.all());
});

app.post('/api/check-ins', (req, res) => {
  try {
    const memberId = String(req.body?.memberId ?? '').trim().toUpperCase();
    if (!memberId) {
      return res.status(400).json({ error: 'Member ID is required.' });
    }

    const row = getMember.get(memberId);
    if (!row) {
      return res.status(404).json({ error: 'Unknown member QR. Ask the owner to add this member first.' });
    }

    const member = mapMember(row);
    const checkedInAt = new Date().toISOString();
    const result = insertCheckIn.run({
      memberId: member.id,
      memberName: member.name,
      checkedInAt,
      membershipStatus: member.membershipStatus,
    });

    res.status(201).json({
      checkIn: {
        id: result.lastInsertRowid,
        memberId: member.id,
        memberName: member.name,
        checkedInAt,
        membershipStatus: member.membershipStatus,
      },
      member,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not log check-in.' });
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

const browserDist = path.join(__dirname, '..', 'dist', 'GymPass', 'browser');
if (fs.existsSync(browserDist)) {
  app.use(
    express.static(browserDist, {
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        // The service worker and its manifest must never be cached by the browser/HTTP layer,
        // otherwise installed clients can get stuck on an old version.
        if (base === 'ngsw-worker.js' || base === 'ngsw.json' || base === 'index.html' || base === 'manifest.webmanifest') {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/-[A-Z0-9]{8}\.(js|css)$/.test(base)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.get(/.*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(browserDist, 'index.html'));
  });
} else {
  console.warn('No Angular build found in dist/. Run "npm run build" (or "npm run demo") first.');
}

function lanUrls() {
  const urls = [];
  const secure = Boolean(tlsOptions());
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(secure ? `https://${net.address}:${HTTPS_PORT}` : `http://${net.address}:${PORT}`);
      }
    }
  }
  return urls;
}

let cachedTls;
function tlsOptions() {
  if (cachedTls !== undefined) {
    return cachedTls;
  }
  const key = process.env.GYMPASS_TLS_KEY || path.join(certDir, 'key.pem');
  const cert = process.env.GYMPASS_TLS_CERT || path.join(certDir, 'cert.pem');
  cachedTls = fs.existsSync(key) && fs.existsSync(cert) ? { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } : null;
  return cachedTls;
}

http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log('\n==============================================');
  console.log(`  ACCESS KEY:  ${ACCESS.key}`);
  console.log(`  (from ${ACCESS.source})`);
  console.log('  Enter it once on each device. Show it again: npm run key');
  console.log('==============================================\n');
  console.log(`GymPass (HTTP)  http://localhost:${PORT}   <- localhost counts as a secure context on this PC`);
  const tls = tlsOptions();
  if (tls) {
    https.createServer(tls, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`GymPass (HTTPS) https://localhost:${HTTPS_PORT}`);
      console.log('\nOpen one of these on phones / tablets / laptops on the same Wi-Fi:');
      for (const url of lanUrls()) {
        console.log(`   ${url}`);
      }
    });
  } else {
    console.warn(
      '\nNo HTTPS certificate found in certs/. Other devices can open the LAN address, but browsers will NOT\n' +
        'enable install / offline / camera on plain http://<lan-ip>. Run "npm run setup:https" (see OFFLINE.md).',
    );
    for (const url of lanUrls()) {
      console.log(`   LAN (http, limited): ${url}`);
    }
  }
});
