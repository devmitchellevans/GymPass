import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { vi } from 'vitest';
import { GymStore } from './gym-store';
import { AuthService } from './auth';
import { GYM_DB } from './db';
import { SyncService } from './sync';
import { SyncResponse } from './models';
import { looksLikeMemberId, normalizeMemberId, addMonthsLocal } from './ids';

// jsdom has no <canvas>, which the browser QR renderer needs.
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,QR') } }));

const iso = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

function serverReply(partial: Partial<SyncResponse> = {}): SyncResponse {
  return { accepted: 0, rejected: [], members: [], checkIns: [], cursor: 0, hasMore: false, serverTime: '', ...partial };
}

describe('offline-first data layer', () => {
  let store: GymStore;
  let sync: SyncService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await GYM_DB.delete();
    await GYM_DB.open();
    fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    store = TestBed.inject(GymStore);
    sync = TestBed.inject(SyncService);
    await GYM_DB.setMeta('accessKey', 'TEST-KEY');
    await TestBed.inject(AuthService).load();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('creates a member and a QR with no network, and queues it for upload', async () => {
    const { member, qrCode } = await store.createMember({
      name: 'Ana', contactNumber: '0917', email: 'ana@example.com', expiresOn: iso(30),
    });
    await sync.syncNow();

    expect(member.id).toMatch(/^GP-[0-9A-F]{8}$/);
    expect(qrCode).toContain('data:image/png');
    expect(member.membershipStatus).toBe('active');
    expect(sync.reachable()).toBe(false);
    expect((await GYM_DB.members.get(member.id))?.sync).toBe(1);
  });

  it('records check-ins offline, flags expired members, and rejects unknown QR codes', async () => {
    const active = (await store.createMember({ name: 'A', contactNumber: '1', email: 'a@b.co', expiresOn: iso(5) })).member;
    const lapsed = (await store.createMember({ name: 'B', contactNumber: '1', email: 'b@b.co', expiresOn: iso(-5) })).member;

    expect((await store.checkIn(active.id)).member.membershipStatus).toBe('active');
    expect((await store.checkIn(lapsed.id)).checkIn.membershipStatus).toBe('expired');
    await expect(store.checkIn('GP-FFFFFFFF')).rejects.toThrow(/not found/i);

    await store.reload();
    expect(store.checkIns().length).toBe(2);
    expect(store.checkIns().every((c) => c.sync === 1)).toBe(true);
  });

  it('ignores a repeat scan inside the kiosk dedupe window', async () => {
    const { member } = await store.createMember({ name: 'A', contactNumber: '1', email: 'a@b.co', expiresOn: iso(5) });
    const first = await store.checkIn(member.id, { dedupeMs: 60_000 });
    const second = await store.checkIn(member.id, { dedupeMs: 60_000 });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await GYM_DB.checkIns.count()).toBe(1);
  });

  it('uploads queued data when the server returns, and merges what other devices recorded', async () => {
    const { member } = await store.createMember({ name: 'Ana', contactNumber: '1', email: 'a@b.co', expiresOn: iso(30) });
    await store.checkIn(member.id);
    await sync.syncNow(); // offline: fetch rejects
    expect(sync.status()).toBe('offline');
    expect(await GYM_DB.checkIns.where('sync').equals(1).count()).toBe(1);

    // Connectivity returns. The server echoes our upload and adds a member + check-in from another device.
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body);
      expect(sent.members.length).toBe(1);
      expect(sent.checkIns.length).toBe(1);
      return new Response(
        JSON.stringify(
          serverReply({
            accepted: 2,
            members: [
              { ...member, deleted: false },
              { id: 'GP-AAAAAAAA', name: 'Other Device Member', contactNumber: '2', email: 'o@b.co', expiresOn: iso(9), createdAt: '', updatedAt: '', deleted: false, membershipStatus: 'active' },
            ],
            checkIns: [
              { id: 7, clientId: 'remote-1', memberId: 'GP-AAAAAAAA', memberName: 'Other Device Member', checkedInAt: new Date().toISOString(), membershipStatus: 'active' },
            ],
            cursor: 7,
          }),
        ),
        { status: 200 },
      );
    });

    await sync.syncNow();

    expect(sync.reachable()).toBe(true);
    expect(await GYM_DB.members.where('sync').anyOf(1, 2).count()).toBe(0);
    expect(await GYM_DB.checkIns.where('sync').anyOf(1, 2).count()).toBe(0);
    expect(await GYM_DB.checkIns.count()).toBe(2);
    expect(await GYM_DB.members.get('GP-AAAAAAAA')).toBeTruthy();
    expect(await GYM_DB.getMeta('cursor', 0)).toBe(7);

    // Next sync sends nothing new and asks only for rows after the cursor.
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body);
      expect(sent.since).toBe(7);
      expect(sent.checkIns.length).toBe(0);
      return new Response(JSON.stringify(serverReply({ cursor: 7 })), { status: 200 });
    });
    await sync.syncNow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends the access key with every sync request', async () => {
    await store.createMember({ name: 'A', contactNumber: '1', email: 'a@b.co', expiresOn: iso(5) });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(serverReply()), { status: 200 }));
    await sync.syncNow();
    const init = fetchMock.mock.calls.at(-1)![1] as { headers: Record<string, string> };
    expect(init.headers['x-gympass-key']).toBe('TEST-KEY');
  });

  it('does not contact the server at all while locked', async () => {
    await TestBed.inject(AuthService).lock();
    fetchMock.mockClear();
    await sync.syncNow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('locks the app and keeps local data when the server rejects the key', async () => {
    const auth = TestBed.inject(AuthService);
    const { member } = await store.createMember({ name: 'A', contactNumber: '1', email: 'a@b.co', expiresOn: iso(5) });
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    await sync.syncNow();
    expect(auth.key()).toBeNull();
    expect(auth.notice()).toMatch(/key/i);
    expect((await GYM_DB.members.get(member.id))?.sync).toBe(1); // still queued, not lost
  });

  it('accepts a correct key and rejects a wrong one', async () => {
    const auth = TestBed.inject(AuthService);
    await auth.lock();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(auth.unlock('nope')).rejects.toThrow(/not correct/);
    expect(auth.key()).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await auth.unlock(' abcd-efgh-jklm ');
    expect(auth.key()).toBe('ABCD-EFGH-JKLM');
    expect(await GYM_DB.getMeta('accessKey', '')).toBe('ABCD-EFGH-JKLM');
  });

  it('marks records the server rejects so they are not retried forever', async () => {
    const { member } = await store.createMember({ name: 'Ana', contactNumber: '1', email: 'a@b.co', expiresOn: iso(30) });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(serverReply({ rejected: [{ kind: 'member', key: member.id, reason: 'Invalid member data.' }] })), { status: 200 }),
    );
    await sync.syncNow();
    expect((await GYM_DB.members.get(member.id))?.sync).toBe(2);
  });

  // ---------------- editing, deleting, typed IDs ----------------

  it('edits a member, keeps the same ID, and queues the change for upload', async () => {
    const { member } = await store.createMember({ name: 'Ana Crus', contactNumber: '1', email: 'a@b.co', expiresOn: iso(-3) });
    await GYM_DB.members.update(member.id, { sync: 0 }); // pretend it already synced

    const saved = await store.updateMember(member.id, { name: 'Ana Cruz', contactNumber: '2', email: 'ana@b.co', expiresOn: iso(30) });

    expect(saved.id).toBe(member.id);
    expect(saved.name).toBe('Ana Cruz');
    expect(saved.membershipStatus).toBe('active'); // renewed
    expect((await GYM_DB.members.get(member.id))?.sync).toBe(1);
    expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(member.updatedAt));
  });

  it('a corrected name also fixes old log rows, but the stored snapshot is kept', async () => {
    const { member } = await store.createMember({ name: 'Ana Crus', contactNumber: '1', email: 'a@b.co', expiresOn: iso(30) });
    await store.checkIn(member.id);
    await store.updateMember(member.id, { name: 'Ana Cruz', contactNumber: '1', email: 'a@b.co', expiresOn: iso(30) });
    await store.reload();
    const row = store.checkIns()[0];
    expect(store.displayName(row)).toBe('Ana Cruz');
    expect(row.memberName).toBe('Ana Crus');
  });

  it('deleting hides the member, blocks check-in, but keeps history', async () => {
    const { member } = await store.createMember({ name: 'Ana', contactNumber: '1', email: 'a@b.co', expiresOn: iso(30) });
    await store.checkIn(member.id);
    await store.deleteMember(member.id);
    await store.reload();

    expect(store.members().length).toBe(0);
    expect(await store.getMember(member.id)).toBeNull();
    await expect(store.checkIn(member.id)).rejects.toThrow(/not found/i);
    expect(store.checkIns().length).toBe(1);
    expect(store.displayName(store.checkIns()[0])).toBe('Ana'); // still readable in the log
    const row = await GYM_DB.members.get(member.id);
    expect(row?.deleted).toBe(true);
    expect(row?.sync).toBe(1); // the deletion itself still has to reach the server
  });

  it('does not lose or mis-mark an edit made while an upload is in flight', async () => {
    const { member } = await store.createMember({ name: 'Ana', contactNumber: '1', email: 'a@b.co', expiresOn: iso(30) });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const bodies: { members: { name: string }[] }[] = [];
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body);
      bodies.push(sent);
      if (bodies.length === 1) {
        await gate; // first request is "in flight" while the user edits again
        return new Response(JSON.stringify(serverReply({ members: [{ ...member, deleted: false }] })), { status: 200 });
      }
      // A real server has applied the newer edit by now and returns it.
      return new Response(JSON.stringify(serverReply({ members: sent.members.map((m: object) => ({ ...m, membershipStatus: 'active' })) })), { status: 200 });
    });

    const syncing = sync.syncNow();
    await new Promise((r) => setTimeout(r, 20));
    await store.updateMember(member.id, { name: 'Ana Edited', contactNumber: '1', email: 'a@b.co', expiresOn: iso(30) });
    release();
    await syncing;

    expect(bodies.length).toBe(2);
    expect(bodies[0].members[0].name).toBe('Ana');
    expect(bodies[1].members[0].name).toBe('Ana Edited'); // the newer edit was not skipped
    const row = await GYM_DB.members.get(member.id);
    expect(row?.name).toBe('Ana Edited');
    expect(row?.sync).toBe(0);
  });

  it('receives a delete made on another device', async () => {
    const { member } = await store.createMember({ name: 'Ana', contactNumber: '1', email: 'a@b.co', expiresOn: iso(30) });
    await GYM_DB.members.update(member.id, { sync: 0 });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(serverReply({ members: [{ ...member, deleted: true, updatedAt: new Date().toISOString() }] })), { status: 200 }),
    );
    await sync.syncNow();
    await store.reload();
    expect(store.members().length).toBe(0);
  });

  it('accepts member IDs typed with or without the GP- prefix', () => {
    expect(normalizeMemberId(' gp-1a2b3c4d ')).toBe('GP-1A2B3C4D');
    expect(normalizeMemberId('1a2b3c4d')).toBe('GP-1A2B3C4D');
    expect(looksLikeMemberId('1A2B3C4D')).toBe(true);
    expect(looksLikeMemberId('Ana')).toBe(false);
  });

  it('renews relative to month ends correctly', () => {
    expect(addMonthsLocal('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsLocal('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonthsLocal('2026-03-10', 12)).toBe('2027-03-10');
  });

  it('upgrades members saved by an older version (no updatedAt / deleted fields)', async () => {
    await GYM_DB.members.add({
      id: 'GP-0LD0LD01'.replace('0LD0LD01', '1A2B3C4D'), name: 'Legacy', contactNumber: '1', email: 'l@b.co',
      expiresOn: iso(30), createdAt: '2026-01-01T00:00:00.000Z', sync: 0,
    });
    await store.reload();
    expect(store.members().map((m) => m.name)).toEqual(['Legacy']);
    expect(store.members()[0].updatedAt).toBe('2026-01-01T00:00:00.000Z');

    const edited = await store.updateMember('GP-1A2B3C4D', { name: 'Legacy Fixed', contactNumber: '1', email: 'l@b.co', expiresOn: iso(30) });
    expect(edited.name).toBe('Legacy Fixed');
    await store.deleteMember('GP-1A2B3C4D');
    await store.reload();
    expect(store.members().length).toBe(0);
  });
});
