import { Component, inject } from '@angular/core';
import { SyncService } from './sync';

@Component({
  selector: 'app-sync-status',
  template: `
    <button
      type="button"
      class="chip"
      [class]="sync.status()"
      (click)="sync.syncNow()"
      [attr.aria-label]="'Sync status: ' + label() + '. Tap to sync now.'"
    >
      <span class="dot"></span>{{ label() }}
    </button>
    @if (sync.rejected() > 0) {
      <span class="chip rejected" [title]="sync.lastError()">{{ sync.rejected() }} need attention</span>
    }
  `,
  styles: `
    :host { display: inline-flex; gap: 0.5rem; flex-wrap: wrap; }
    .chip {
      display: inline-flex; align-items: center; gap: 0.5rem; border: 0; cursor: pointer;
      padding: 0.4rem 0.85rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600;
      color: #e8f3ed; background: #14241d; box-shadow: inset 0 0 0 1px #234033;
    }
    .dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: #7dffb3; }
    .offline .dot { background: #ffb347; }
    .pending .dot, .syncing .dot { background: #ffe066; }
    .syncing .dot { animation: pulse 1s infinite; }
    .rejected { color: #ff9b9b; cursor: default; }
    @keyframes pulse { 50% { opacity: 0.3; } }
  `,
})
export class SyncStatusChip {
  readonly sync = inject(SyncService);

  label() {
    const n = this.sync.pending();
    switch (this.sync.status()) {
      case 'syncing':
        return 'Syncing…';
      case 'offline':
        return n > 0 ? `Offline · ${n} waiting to sync` : 'Offline · saved on this device';
      case 'pending':
        return `${n} waiting to sync`;
      default:
        return 'Online · all synced';
    }
  }
}
