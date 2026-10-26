import { DatePipe, TitleCasePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { GymStore } from './gym-store';
import { InstallService } from './install';
import { SyncService } from './sync';
import { SyncStatusChip } from './sync-status';

/** Dashboard: recent check-ins plus entry points to Members and Kiosk mode. */
@Component({
  selector: 'app-home',
  imports: [DatePipe, RouterLink, SyncStatusChip, TitleCasePipe],
  templateUrl: './home.html',
  styleUrl: './ui.css',
})
export class Home {
  readonly store = inject(GymStore);
  readonly sync = inject(SyncService);
  readonly install = inject(InstallService);

  readonly checkIns = this.store.checkIns;
  readonly counts = this.store.counts;

  refreshLogs() {
    void this.sync.syncNow();
  }
}
