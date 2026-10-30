# GymPass: offline-first PWA

GymPass now keeps its own copy of members and check-ins **on each device** (IndexedDB), so it keeps
working with no internet and even with the host PC switched off. Everything is uploaded to the PC's
SQLite database automatically when the PC is reachable again.

```
 phone / tablet / laptop                          your PC
┌──────────────────────────┐   POST /api/sync   ┌───────────────────────┐
│ Angular PWA              │ ─────────────────► │ Express + SQLite      │
│  • service worker (app)  │ ◄───────────────── │  • one shared DB      │
│  • IndexedDB (data)      │  new members/logs  │  • idempotent upserts │
│  • outbox of pending rows│                    └───────────────────────┘
└──────────────────────────┘
```

## 1. Run the demo on your PC

```bash
npm install
npm run setup:https     # once: needs mkcert (winget install FiloSottile.mkcert)
npm run demo            # builds Angular, starts the server
```

The console prints the addresses to open on other devices, e.g. `https://192.168.1.20:3443`.

**Windows:** the first time, allow Node.js through the firewall for *Private* networks, or phones
won't be able to connect.

## 2. Open it on phones, tablets and laptops (same Wi-Fi)

**Why HTTPS?** Browsers only allow service workers (offline), the install prompt and the camera on
secure origins. `localhost` counts as secure, but `http://192.168.x.x` does **not**. So other devices
need `https://`, with a certificate they trust:

1. On the device, open `http://<pc-ip>:3000/rootCA.pem` and install it as a trusted certificate
   * Android: Settings → Security → Install a certificate → CA certificate
   * iPhone/iPad: install the downloaded profile, then Settings → General → About →
     Certificate Trust Settings → enable it
   * Windows/macOS laptops: double-click the file and trust it (or run `mkcert -install` there)
2. Open `https://<pc-ip>:3443`
3. Install: Chrome/Edge show **Install app** (also in the app header); on iOS use Share → Add to Home Screen.

Do step 1 once per device. Re-run `npm run setup:https` if the PC's Wi-Fi IP address changes.

### Option B: reach it from a *different* network (no certificates)

A PC at home is not reachable from another network by itself. A tunnel gives it a public HTTPS address
(which also removes the certificate step):

```bash
npm run demo
cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
```

Open that address on any device, anywhere, then install. Once installed, the app lives on the device and
works offline; it only needs the tunnel (or the LAN) again to sync.

> The tunnel URL is public, but the data is protected by the **access key** (section 2b). Still, stop
> the tunnel (Ctrl+C) when the demo is over, and use fake data for demos.

## 2b. Access key

The server protects all data with a key, so people who can reach the address but don't have the key
see only a lock screen.

* The first time the server starts it creates a key such as `K7QM-4TXD-9HPA`, saves it in
  `data/access-key.txt`, and prints it in the console.
* Show it again any time: `npm run key`. Make a new one: `npm run key -- --new`, then restart the server.
* Or set your own: `GYMPASS_ACCESS_KEY=my-gym-key npm run demo`
* On each device, enter the key **once**. It is remembered on that device, so offline use keeps working.
* If you change the key, devices ask for the new one the next time they sync. Their unsynced data is kept.
* 10 wrong guesses from one address block that address for 10 minutes (even a correct key is refused
  during that time).

What the key does **not** do:
* It does not encrypt data that is already saved on a device. Anyone who can use an unlocked phone or
  tablet can see what is on it. Keep kiosk tablets physically secure.
* It travels in a request header, so keep using HTTPS (or a tunnel) when you leave your own network.
* It is one shared key, not per-person accounts. Anyone who learns it has full access.

## 3. What works offline

| Action | Offline? |
|---|---|
| Open the installed app | ✅ (served from the service worker cache) |
| Add / edit / delete members, search, view profiles | ✅ |
| Generate a member's QR | ✅ (ID and QR are created on the device) |
| Check in at `/kiosk` (QR, name or ID) | ✅ for any member the device has already downloaded |
| View check-in log | ✅ |
| Send the QR by email from the server | ❌ needs the server; use **Share…** (works offline) to attach the picture in Gmail/Mail |

The header chip shows `Online · all synced`, `Offline · N waiting to sync`, etc. Pending rows are tagged
**waiting to sync** in the log.

## 3b. Members (add, view, edit, delete)

**Home → Members** is the one place to manage people:

* **Search** by name, member ID, email or phone; filter All / Active / Expired.
* **View** a profile: details, last edit, number of check-ins and the most recent ones.
* **Edit** name, phone, email and the expiry date. Quick buttons (+1, +3, +12 months, *Set expired*) renew
  from the later of today and the current expiry. Membership status (Active / Expired) always follows the
  expiry date. The member ID and QR code never change, so a printed or emailed QR stays valid.
* **Delete** (with confirmation). The member disappears from every device and their QR stops working,
  but their past check-ins stay in the log.
* **Add member** works as before: it creates the member and shows the QR, with **Save QR** and
  **Send via email**.

**Sending or saving a member's QR (phones, tablets and laptops)**

| Button | What it does |
|---|---|
| **Send via email** | The *server* emails the member with the QR inside the message **and** attached as a PNG. Works from any device, but needs the email account set up (below) and a connection to the server. |
| **Share…** | Opens the phone's share sheet with the QR picture attached: pick Gmail, Mail, WhatsApp, Messages, AirDrop… Needs **https** (see section 2). Hidden where the browser can't share files. |
| **Save QR** | Laptop / Android: downloads `GP-XXXXXXXX.png`. iPhone / iPad: opens the share sheet, where you choose **Save Image**. (iOS ignores download links in web apps.) |
| **Open email app** | Shown only when the server can't send. Starts a draft addressed to the member with their ID. **A web page cannot attach a picture to a mail link**, so use **Share…** to attach the image. |

You can also press and hold the QR picture on a phone to save or share it.

### Setting up server email (one time)

1. Copy `.env.example` to `.env` (same folder as `package.json`) and fill it in. For Gmail, create an
   **App password** (Google Account → Security → 2-Step Verification → App passwords) and use it as
   `SMTP_PASS`; your normal Gmail password will not work.
2. Restart `npm run demo`. Real environment variables override `.env`; `.env` is git-ignored.

If sending fails, the dialog says why: *no email account set up*, *the email account refused the login*, or
*could not reach the email provider*.

**Sync rules**
* Check-ins and members get a unique ID on the device, and the server ignores repeats, so a retry can
  never create duplicates.
* Devices sync on start, when the browser regains a connection, when the app returns to the foreground,
  and every 15 s. Tap the chip (or **Sync now**) to force it.
* Records the server refuses (e.g. a check-in for a member it has never seen) are marked
  **need attention** instead of being retried forever.

**Limits to know about**
* A device can only check in members it has downloaded. Open each tablet/kiosk once while connected, enter the access key, so it
  pulls the member list. A member created offline on device A is not scannable on device B until A syncs.
* Syncing runs while the app is open. There is no background sync (iOS does not support it).
* Clearing site data / uninstalling the app deletes anything that has not synced yet.
* **If two devices change the same member, the most recent edit wins, as a whole.** (Not field by field.)
  Example: the front desk fixes a phone number offline at 9:00 and the owner fixes the name online at 9:05;
  when the desk reconnects its older edit is discarded and it receives the owner's version. Edit times come
  from each device's clock; the server ignores times in the future so one wrong clock cannot win forever.
* Deleting is a "soft delete" kept on the server, so other devices learn about it. A check-in recorded
  offline for a member who was deleted meanwhile is still kept in the log.
* Old log rows show the member's *current* name, so correcting a typo also fixes past rows.

## 4. Kiosk mode

`/kiosk` is a self-service screen: it opens the camera immediately, shows a large green / amber / red
result, ignores a QR that is still held up (60 s), keeps the screen awake and resets itself.
Under the camera, **“No QR? Use your name or ID”** lets someone check in by typing:

* **Member ID**, with or without the `GP-` prefix, any capitalisation.
* **Name**: suggestions appear after 3 letters, at most 5, showing the name and the last 4 characters of the
  ID (to tell two people with the same name apart). Because a kiosk can be touched by anyone, if you don't
  want names shown at all, open **`/kiosk?lookup=id`**: then only a typed ID works.
* If the camera is unavailable, the typed option opens automatically.

Kiosk mode is also an installed-app shortcut (long-press the app icon on Android).

Dedicated hardware options today:

```bash
# Windows/Linux/ChromeOS kiosk machine
chrome --kiosk --app=https://<pc-ip>:3443/kiosk
# Android tablet: install the PWA, open /kiosk, then use Screen Pinning or a kiosk launcher
```

Built-in hooks for the next steps: every check-in records a `deviceId`, so you can tell kiosks apart.

## 4b. App-like behaviour on phones

* Pinch-zoom and double-tap zoom are disabled, only vertical scrolling is allowed, and scrollbars are hidden
  (`src/styles.css`, the viewport tag in `src/index.html`, and a small gesture block in `src/main.ts`
  for iOS, which ignores the viewport setting).
* **Rule to keep it working:** nothing on a page may be wider than the screen. If it is, iOS Safari shrinks
  the whole page to fit it, and with zoom locked you can't zoom back in. That's why lists switch to stacked
  cards below 640 px wide (`src/app/ui.css`). If you add a wide element (table, image, long unbroken text),
  make it wrap or give it `max-width: 100%`.
* Zoom lock makes the app harder to read for people with low vision. It suits staff tablets and the kiosk;
  if members use the app on their own phones, consider allowing zoom (remove `maximum-scale` and
  `user-scalable=no` from `src/index.html`).

## 5. Roadmap / ideas
* Staff PIN to leave kiosk mode; per-device names ("Front desk")
* Per-user logins / roles instead of one shared key (e.g. separate kiosk and owner access)
* A "suspended" status (separate from the expiry date), and per-field merging of edits
* Auto-reload kiosks when a new version is deployed
* Optional kiosk beep + haptics

## Commands

| | |
|---|---|
| `npm run demo` | build + serve on `:3000` (http) and `:3443` (https if `certs/` exists) |
| `npm run setup:https` | create the trusted local certificate with mkcert |
| `npm run key` | show the access key (`-- --new` creates a new one) |
| `npm run dev` | live-reload development (service worker disabled) |
| `npm test` | unit tests (offline data layer + sync) |

Settings can go in a `.env` file (see `.env.example`) or be real environment variables: `GYMPASS_ACCESS_KEY`, `PORT`, `HTTPS_PORT`, `GYMPASS_CERT_DIR`, `GYMPASS_TLS_KEY`, `GYMPASS_TLS_CERT`,
plus the existing `SMTP_*` / `MAIL_FROM`.
