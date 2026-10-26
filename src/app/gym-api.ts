import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { AuthError, AuthService } from './auth';
import { SyncResponse } from './models';

/** Thin network layer. Nothing in the UI calls this directly except through SyncService / GymStore. */
@Injectable({ providedIn: 'root' })
export class GymApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  /** Uses fetch so we can enforce a hard timeout: on flaky Wi-Fi a hung request must not block the UI. */
  async sync(body: unknown, timeoutMs = 8000): Promise<SyncResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-gympass-key': this.auth.key() ?? '' },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (response.status === 401) {
        throw new AuthError();
      }
      if (!response.ok) {
        throw new Error(`Sync failed (${response.status})`);
      }
      return (await response.json()) as SyncResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Email needs a mail server, so it is the one feature that genuinely requires connectivity. */
  emailMemberQr(id: string) {
    return this.http.post<{ sent: boolean }>(
      `/api/members/${encodeURIComponent(id)}/email`,
      {},
      { headers: { 'x-gympass-key': this.auth.key() ?? '' } },
    );
  }
}
