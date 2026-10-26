import { Component, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';
import { AuthService } from './auth';
import { SyncService } from './sync';
import { Unlock } from './unlock';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Unlock],
  template: `
    @if (auth.ready()) {
      @if (auth.key()) {
        <router-outlet />
      } @else {
        <app-unlock />
      }
    }
    @if (updateReady()) {
      <div class="update">
        A new version of GymPass is ready.
        <button type="button" (click)="reload()">Reload</button>
      </div>
    }
  `,
  styles: `
    .update {
      position: fixed; left: 50%; bottom: 1rem; transform: translateX(-50%); z-index: 50;
      display: flex; gap: 1rem; align-items: center; padding: 0.7rem 1.1rem; border-radius: 999px;
      background: #14241d; box-shadow: 0 0 0 1px #3d5a4d, 0 8px 24px #0008; color: #e8f3ed;
    }
    .update button { border: 0; border-radius: 999px; padding: 0.4rem 0.9rem; font-weight: 700; background: #7dffb3; color: #10231c; cursor: pointer; }
  `,
})
export class App {
  private readonly updates = inject(SwUpdate, { optional: true });
  readonly auth = inject(AuthService);
  readonly updateReady = signal(false);

  constructor() {
    const sync = inject(SyncService);
    void this.auth.load().then(() => sync.syncNow());
    sync.start();

    if (this.updates?.isEnabled) {
      this.updates.versionUpdates
        .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
        .subscribe(() => this.updateReady.set(true));
      // Installed apps are rarely "reloaded", so look for new builds regularly.
      setInterval(() => void this.updates!.checkForUpdate().catch(() => undefined), 5 * 60_000);
    }
  }

  reload() {
    location.reload();
  }
}
