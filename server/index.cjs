const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT) || 3000;
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
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

const insertMember = db.prepare(`
  INSERT INTO members (id, name, contact_number, email, expires_on, created_at)
  VALUES (@id, @name, @contactNumber, @email, @expiresOn, @createdAt)
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
const OWNER_KEY = process.env.OWNER_KEY || '';
if (!OWNER_KEY) {
  console.warn('OWNER_KEY is not set: all /api routes except /api/health will return 401.');
}

function requireOwner(req, res, next) {
  const provided = Buffer.from(String(req.get('x-owner-key') ?? ''));
  const expected = Buffer.from(OWNER_KEY);
  const ok =
    expected.length > 0 &&
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected);
  if (!ok) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

// Protect everything under /api except the health check
app.use('/api', (req, res, next) =>
  req.path === '/health' ? next() : requireOwner(req, res, next),
);
app.get('/api/health', (_req, res) => {
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
  if (!row) {
    return res.status(404).json({ error: 'Member not found.' });
  }
  res.json(mapMember(row));
});

app.post('/api/members/:id/email', async (req, res) => {
  try {
    const row = getMember.get(req.params.id);
    if (!row) {
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
    await transport.sendMail({
      from,
      to: member.email,
      subject: `Your GymPass QR — ${member.id}`,
      text: `Hi ${member.name},\n\nYour GymPass member ID is ${member.id}. Present this QR code at the gym to check in.\nMembership expires on ${member.expiresOn}.\n`,
      html: `<p>Hi ${member.name},</p><p>Your GymPass member ID is <strong>${member.id}</strong>. Present this QR code at the gym to check in.</p><p>Membership expires on ${member.expiresOn}.</p><p><img src="cid:gympass-qr" alt="GymPass QR" /></p>`,
      attachments: [
        {
          filename: `${member.id}.png`,
          content: Buffer.from(qrCode.split(',')[1], 'base64'),
          cid: 'gympass-qr',
        },
      ],
    });

    res.json({ sent: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not send the member QR email.' });
  }
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

const browserDist = path.join(__dirname, '..', 'dist', 'GymPass', 'browser');
if (fs.existsSync(browserDist)) {
  app.use(express.static(browserDist));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(browserDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`GymPass API running on http://localhost:${PORT}`);
});
