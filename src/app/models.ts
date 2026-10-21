export type MembershipStatus = 'active' | 'expired';

export interface Member {
  id: string;
  name: string;
  contactNumber: string;
  email: string;
  expiresOn: string;
  createdAt: string;
  membershipStatus: MembershipStatus;
}

export interface CheckIn {
  id: number;
  memberId: string;
  memberName: string;
  checkedInAt: string;
  membershipStatus: MembershipStatus;
}

export interface CreatedMemberResponse {
  member: Member;
  qrCode: string;
}

export interface CheckInResponse {
  checkIn: CheckIn;
  member: Member;
}
