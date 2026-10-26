export type MembershipStatus = 'active' | 'expired';

/** 0 = synced with the server, 1 = waiting to upload, 2 = rejected by the server (needs attention). */
export type SyncState = 0 | 1 | 2;

export interface Member {
  id: string;
  name: string;
  contactNumber: string;
  email: string;
  expiresOn: string;
  createdAt: string;
  /** Time of the last edit. Used for "last edit wins" when two devices change the same member. */
  updatedAt: string;
  membershipStatus: MembershipStatus;
}

/** A member as stored in IndexedDB. `membershipStatus` is always recomputed from `expiresOn`. */
export interface LocalMember extends Omit<Member, 'membershipStatus' | 'updatedAt'> {
  /** Older saved rows may not have this yet; `createdAt` is used instead. */
  updatedAt?: string;
  /** Soft delete: hidden everywhere, but kept so the deletion can sync and history stays intact. */
  deleted?: boolean;
  sync: SyncState;
}

export interface CheckIn {
  /** Globally unique, created on the device that scanned. Makes uploads idempotent. */
  clientId: string;
  memberId: string;
  memberName: string;
  checkedInAt: string;
  membershipStatus: MembershipStatus;
  deviceId?: string;
  sync: SyncState;
}

export interface NewMemberInput {
  name: string;
  contactNumber: string;
  email: string;
  expiresOn: string;
}

export interface CreatedMemberResult {
  member: Member;
  qrCode: string;
}

export interface CheckInResult {
  checkIn: CheckIn;
  member: Member;
  /** True when the same member was scanned moments ago and no new row was written. */
  duplicate: boolean;
}

export interface SyncResponse {
  accepted: number;
  rejected: { kind: 'member' | 'checkIn'; key: string; reason: string }[];
  members: (Member & { deleted: boolean })[];
  checkIns: (Omit<CheckIn, 'sync'> & { id: number })[];
  cursor: number;
  hasMore: boolean;
  serverTime: string;
}
