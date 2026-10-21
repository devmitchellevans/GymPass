import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { CheckIn, CheckInResponse, CreatedMemberResponse, Member } from './models';

@Injectable({ providedIn: 'root' })
export class GymApi {
  private readonly http = inject(HttpClient);

  createMember(body: { name: string; contactNumber: string; email: string; expiresOn: string }) {
    return this.http.post<CreatedMemberResponse>('/api/members', body);
  }

  getMember(id: string) {
    return this.http.get<Member>(`/api/members/${encodeURIComponent(id)}`);
  }

  emailMemberQr(id: string) {
    return this.http.post<{ sent: boolean }>(`/api/members/${encodeURIComponent(id)}/email`, {});
  }

  listCheckIns() {
    return this.http.get<CheckIn[]>('/api/check-ins');
  }

  checkIn(memberId: string) {
    return this.http.post<CheckInResponse>('/api/check-ins', { memberId });
  }
}
