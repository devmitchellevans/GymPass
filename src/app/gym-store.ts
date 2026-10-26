import { computed, effect, inject, Injectable, signal } from '@angular/core';
import QRCode from 'qrcode';
import { createMemberId, createUuid, normalizeMemberId, todayLocalDate } from './ids';
import { CheckIn, CheckInResult, CreatedMemberResult, LocalMember, Member, NewMemberInput } from './models';
import { SyncService } from './sync';

export function withStatus(m: LocalMember): Member {
  const { sync: _sync, deleted: _deleted, updatedAt, ...rest } = m;
  return {
    ...rest,
    updatedAt: updatedAt ?? m.createdAt,
    membershipStatus: m.expiresOn >= todayLocalDate() ? 'active' : 'expired',
  };
}

/** QR image generated in the browser, so a pass can be issued with no connection at all. */
export function memberQrDataUrl(memberId: string): Promise<string> {
  return QRCode.toDataURL(memberId, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
    color: { dark: '#10231c', light: '#ffffff' },
  });
}

function clean(input: NewMemberInput): NewMemberInput {
  return {
    name: input.name.trim(),
    contactNumber: input.contactNumber.trim(),
    email: input.email.trim(),
    expiresOn: input.expiresOn,
  };
}

export interface MemberHistory {
  total: number;
  last: CheckIn | null;
  recent: CheckIn[];
}

/** The only data API the UI talks to. Writes land in IndexedDB first, then sync in the background. */
@Injectable({ providedIn: 'root' })
export class GymStore {
  private readonly sync = inject(SyncService);
  private readonly db = this.sync.db;

  readonly checkIns = signal<CheckIn[]>([]);
  /** Current (not deleted) members, sorted by name. */
  readonly members = signal<Member[]>([]);
  private readonly names = signal<Map<string, string>>(new Map());
  readonly counts = computed(() => {
    const list = this.members();
    const active = list.filter((m) => m.membershipStatus === 'active').length;
    return { all: list.length, active, expired: list.length - active };
  });

  constructor() {
    effect(() => {
      this.sync.dataVersion();
      void this.reload();
    });
  }

  async reload() {
    const [rows, all] = await Promise.all([
      this.db.checkIns.orderBy('checkedInAt').reverse().limit(200).toArray(),
      this.db.members.toArray(),
    ]);
    this.checkIns.set(rows);
    this.members.set(
      all
        .filter((m) => !m.deleted)
        .map(withStatus)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    );
    // Includes deleted members so old log rows still show a name.
    this.names.set(new Map(all.map((m) => [m.id, m.name])));
  }

  /** The member's current name (so a corrected typo also fixes old log rows). */
  displayName(row: CheckIn): string {
    return this.names().get(row.memberId) ?? row.memberName;
  }

  async createMember(input: NewMemberInput): Promise<CreatedMemberResult> {
    let id = createMemberId();
    while (await this.db.members.get(id)) {
      id = createMemberId();
    }
    const now = new Date().toISOString();
    const local: LocalMember = { id, ...clean(input), createdAt: now, updatedAt: now, deleted: false, sync: 1 };
    await this.db.members.add(local);
    this.changed();
    return { member: withStatus(local), qrCode: await memberQrDataUrl(id) };
  }

  async updateMember(id: string, input: NewMemberInput): Promise<Member> {
    const row = await this.db.members.get(id);
    if (!row || row.deleted) {
      throw new Error('This member no longer exists.');
    }
    const next: LocalMember = { ...row, ...clean(input), updatedAt: new Date().toISOString(), sync: 1 };
    await this.db.members.put(next);
    this.changed();
    return withStatus(next);
  }

  /** Soft delete. Past check-ins stay in the log. */
  async deleteMember(id: string): Promise<void> {
    const row = await this.db.members.get(id);
    if (!row || row.deleted) {
      return;
    }
    await this.db.members.put({ ...row, deleted: true, updatedAt: new Date().toISOString(), sync: 1 });
    this.changed();
  }

  async getMember(id: string): Promise<Member | null> {
    const row = await this.db.members.get(normalizeMemberId(id));
    return row && !row.deleted ? withStatus(row) : null;
  }

  async memberHistory(id: string, limit = 8): Promise<MemberHistory> {
    const all = await this.db.checkIns.where('memberId').equals(id).sortBy('checkedInAt'); // oldest first
    return { total: all.length, last: all.at(-1) ?? null, recent: all.slice(-limit).reverse() };
  }

  /**
   * Records a check-in locally. `dedupeMs` lets kiosk mode ignore a QR that is still held
   * in front of the camera.
   */
  async checkIn(rawMemberId: string, opts: { dedupeMs?: number } = {}): Promise<CheckInResult> {
    const memberId = normalizeMemberId(rawMemberId);
    const row = await this.db.members.get(memberId);
    if (!row || row.deleted) {
      throw new Error(
        this.sync.reachable()
          ? 'Member not found. Please see the front desk.'
          : 'Member not found on this device. It may not have been downloaded yet; reconnect once to refresh the member list.',
      );
    }
    const member = withStatus(row);

    if (opts.dedupeMs) {
      const last = await this.db.checkIns.where('memberId').equals(memberId).reverse().sortBy('checkedInAt');
      const recent = last[0];
      if (recent && Date.now() - Date.parse(recent.checkedInAt) < opts.dedupeMs) {
        return { checkIn: recent, member, duplicate: true };
      }
    }

    const checkIn: CheckIn = {
      clientId: createUuid(),
      memberId,
      memberName: member.name,
      checkedInAt: new Date().toISOString(),
      membershipStatus: member.membershipStatus,
      deviceId: await this.sync.deviceId(),
      sync: 1,
    };
    await this.db.checkIns.add(checkIn);
    this.changed();
    return { checkIn, member, duplicate: false };
  }

  private changed() {
    this.sync.notifyChanged();
    this.sync.syncSoon();
  }
}
