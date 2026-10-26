import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { GymApi } from './gym-api';
import { GYM_DB, GymDb } from './db';
import { AuthError, AuthService } from './auth';
import { createUuid } from './ids';
import { CheckIn, LocalMember } from './models';

export type SyncStatus = 'synced' | 'pending' | 'offline' | 'syncing';

const SYNC_INTERVAL_MS = 15_000;

@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly api = inject(GymApi);
  private readonly auth = inject(AuthService);
  readonly db: GymDb = GYM_DB;

  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private started = false;

  /** True when the last attempt reached the GymPass server (not merely "the Wi-Fi is on"). */
  readonly reachable = signal(false);
  readonly syncing = signal(false);
  readonly pending = signal(0);
  readonly rejected = signal(0);
  readonly lastSyncedAt = signal<string | null>(null);
  readonly lastError = signal('');
  /** Bumped whenever local data changes so views can reload. */
  readonly dataVersion = signal(0);

  readonly status = computed<SyncStatus>(() => {
    if (this.syncing()) return 'syncing';
    if (!this.reachable()) return 'offline';
    return this.pending() > 0 ? 'pending' : 'synced';
  });

  constructor() {
    effect(() => {
      this.dataVersion();
      void this.refreshCounts();
    });
  }

  /** Call once at app start. Safe to call again. */
  start() {
    if (this.started) return;
    this.started = true;

    void this.refreshCounts();
    void this.syncNow();

    window.addEventListener('online', () => void this.syncNow());
    window.addEventListener('offline', () => this.reachable.set(false));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.syncNow();
    });
    // navigator.onLine only says the radio is up. Polling the server is the real test and also
    // retries uploads automatically once the server (or internet) comes back.
    setInterval(() => void this.syncNow(), SYNC_INTERVAL_MS);
  }

  notifyChanged() {
    this.dataVersion.update((v) => v + 1);
  }

  /** Debounced-by-design trigger used right after a local write. */
  syncSoon() {
    void this.syncNow();
  }

  /**
   * Runs a sync, or joins the one already in flight. The returned promise resolves only after
   * everything written before this call has been attempted, so callers can safely `await` it.
   */
  syncNow(): Promise<void> {
    if (!this.auth.key()) {
      return Promise.resolve(); // locked: nothing may talk to the server until a key is entered
    }
    if (this.inFlight) {
      this.rerun = true; // something new was written mid-sync; go again right after
      return this.inFlight;
    }
    this.syncing.set(true);
    this.inFlight = (async () => {
      try {
        do {
          this.rerun = false;
          await this.syncOnce();
        } while (this.rerun && this.reachable());
      } finally {
        this.inFlight = null;
        this.syncing.set(false);
      }
    })();
    return this.inFlight;
  }

  private async syncOnce() {
    const db = this.db;
    try {
      const deviceId = await this.deviceId();
      const members = await db.members.where('sync').equals(1).toArray();
      const checkIns = await db.checkIns.where('sync').equals(1).toArray();
      let since = await db.getMeta<number>('cursor', 0);

      let first = true;
      for (let page = 0; page < 50; page++) {
        const res = await this.api.sync({
          deviceId,
          since,
          members: first
            ? members.map(({ sync: _s, deleted, updatedAt, ...m }) => ({
                ...m,
                updatedAt: updatedAt ?? m.createdAt,
                deleted: Boolean(deleted),
              }))
            : [],
          checkIns: first ? checkIns.map(({ sync: _s, ...c }) => c) : [],
        });

        await db.transaction('rw', db.members, db.checkIns, db.meta, async () => {
          if (first) {
            const bad = new Set(res.rejected.map((r) => r.key));
            for (const m of members) {
              // Only mark it uploaded if it was not edited again while the request was in flight.
              const current = await db.members.get(m.id);
              if (current && current.updatedAt === m.updatedAt) {
                await db.members.update(m.id, { sync: bad.has(m.id) ? 2 : 0 });
              }
            }
            for (const c of checkIns) {
              await db.checkIns.update(c.clientId, { sync: bad.has(c.clientId) ? 2 : 0 });
            }
          }
          // Server copy wins for anything that is not still waiting to upload.
          const waiting = new Set((await db.members.where('sync').anyOf(1, 2).primaryKeys()) as string[]);
          const fresh: LocalMember[] = res.members
            .filter((m) => !waiting.has(m.id))
            .map(({ membershipStatus: _ms, ...m }) => ({ ...m, sync: 0 as const }));
          await db.members.bulkPut(fresh);
          await db.checkIns.bulkPut(
            res.checkIns.map(({ id: _id, ...c }) => ({ ...c, sync: 0 as const })),
          );
          await db.setMeta('cursor', res.cursor);
        });

        since = res.cursor;
        first = false;
        this.lastError.set(res.rejected.length ? res.rejected[0].reason : '');
        if (!res.hasMore) break;
      }

      this.reachable.set(true);
      const now = new Date().toISOString();
      this.lastSyncedAt.set(now);
      await db.setMeta('lastSyncedAt', now);
    } catch (error) {
      if (error instanceof AuthError) {
        // Wrong or changed key. The server answered, so it is reachable, but we must stop and re-ask.
        this.reachable.set(true);
        await this.auth.lock('The access key was changed or is no longer valid. Enter the new key.');
        return;
      }
      this.reachable.set(false);
      this.lastError.set(error instanceof Error ? error.message : 'Sync failed.');
    }
    this.notifyChanged();
  }

  private async refreshCounts() {
    const [m, c, rm, rc] = await Promise.all([
      this.db.members.where('sync').equals(1).count(),
      this.db.checkIns.where('sync').equals(1).count(),
      this.db.members.where('sync').equals(2).count(),
      this.db.checkIns.where('sync').equals(2).count(),
    ]);
    this.pending.set(m + c);
    this.rejected.set(rm + rc);
  }

  async deviceId(): Promise<string> {
    let id = await this.db.getMeta<string>('deviceId', '');
    if (!id) {
      id = createUuid();
      await this.db.setMeta('deviceId', id);
    }
    return id;
  }
}

export { GYM_DB };
export type { CheckIn };
