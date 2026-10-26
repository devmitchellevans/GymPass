import { Injectable, signal } from '@angular/core';
import { GYM_DB } from './db';

export class AuthError extends Error {
  constructor(message = 'Access key required.') {
    super(message);
  }
}

const META_KEY = 'accessKey';

/**
 * Holds the server access key. It is stored on the device (IndexedDB) so the installed app keeps
 * working offline. Note: it protects the *server*; data already saved on a device stays readable
 * by whoever can use that device.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  /** The saved key, or null when this device has not been unlocked yet. */
  readonly key = signal<string | null>(null);
  /** False until the saved key has been read from storage (avoids flashing the unlock screen). */
  readonly ready = signal(false);
  readonly notice = signal('');

  private loading: Promise<void> | null = null;

  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const saved = await GYM_DB.getMeta<string>(META_KEY, '');
        this.key.set(saved || null);
      } finally {
        this.ready.set(true);
      }
    })();
    return this.loading;
  }

  /** Checks the key with the server and, if correct, saves it. Throws a readable Error otherwise. */
  async unlock(candidate: string): Promise<void> {
    const key = candidate.trim().toUpperCase();
    if (!key) {
      throw new Error('Enter the access key.');
    }
    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      response = await fetch('/api/auth/check', {
        method: 'POST',
        headers: { 'x-gympass-key': key },
        cache: 'no-store',
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    } catch {
      throw new Error('Cannot reach the GymPass server. Connect to it once to enter the key.');
    }
    if (response.status === 429) {
      throw new Error('Too many wrong keys. Wait a few minutes and try again.');
    }
    if (!response.ok) {
      throw new Error('That key is not correct.');
    }
    await GYM_DB.setMeta(META_KEY, key);
    this.notice.set('');
    this.key.set(key);
  }

  /** Forget the key (e.g. the server rotated it). Local data is kept, only server access is revoked. */
  async lock(message = '') {
    await GYM_DB.meta.delete(META_KEY);
    this.notice.set(message);
    this.key.set(null);
  }
}
