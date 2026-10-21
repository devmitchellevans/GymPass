import { DatePipe, TitleCasePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  afterNextRender,
  Component,
  ElementRef,
  inject,
  Injector,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Html5Qrcode } from 'html5-qrcode';
import { GymApi } from './gym-api';
import { CheckIn, Member } from './models';

@Component({
  selector: 'app-home',
  imports: [DatePipe, ReactiveFormsModule, TitleCasePipe],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home implements OnDestroy {
  private readonly api = inject(GymApi);
  private readonly injector = inject(Injector);
  private readonly fb = inject(FormBuilder);
  private scanner: Html5Qrcode | null = null;
  private scanning = false;
  private handlingScan = false;

  readonly scannerHost = viewChild<ElementRef<HTMLElement>>('scannerHost');

  readonly checkIns = signal<CheckIn[]>([]);
  readonly loadError = signal('');
  readonly notice = signal('');
  readonly addOpen = signal(false);
  readonly saving = signal(false);
  readonly addError = signal('');
  readonly passOpen = signal(false);
  readonly createdMember = signal<Member | null>(null);
  readonly qrCode = signal('');
  readonly emailing = signal(false);
  readonly emailNotice = signal('');
  readonly scanOpen = signal(false);
  readonly scanError = signal('');
  readonly expiredOpen = signal(false);
  readonly expiredMember = signal<Member | null>(null);

  readonly memberForm = this.fb.nonNullable.group({
    name: ['', Validators.required],
    contactNumber: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    expiresOn: [this.defaultExpiry(), Validators.required],
  });

  constructor() {
    this.refreshLogs();
  }

  ngOnDestroy() {
    void this.stopScanner();
  }

  refreshLogs() {
    this.api.listCheckIns().subscribe({
      next: (rows) => {
        this.checkIns.set(rows);
        this.loadError.set('');
      },
      error: () => this.loadError.set('Cannot reach the GymPass database. Start it with npm run api.'),
    });
  }

  openAddMember() {
    this.addError.set('');
    this.memberForm.reset({
      name: '',
      contactNumber: '',
      email: '',
      expiresOn: this.defaultExpiry(),
    });
    this.addOpen.set(true);
  }

  closeAddMember() {
    if (!this.saving()) {
      this.addOpen.set(false);
    }
  }

  addMember() {
    if (this.memberForm.invalid) {
      this.memberForm.markAllAsTouched();
      this.addError.set('Fill in name, contact number, and email.');
      return;
    }

    this.saving.set(true);
    this.addError.set('');
    this.api.createMember(this.memberForm.getRawValue()).subscribe({
      next: ({ member, qrCode }) => {
        this.saving.set(false);
        this.addOpen.set(false);
        this.createdMember.set(member);
        this.qrCode.set(qrCode);
        this.emailNotice.set('');
        this.passOpen.set(true);
      },
      error: (error: HttpErrorResponse) => {
        this.saving.set(false);
        this.addError.set(this.errorMessage(error, 'Could not add this member.'));
      },
    });
  }

  closePass() {
    this.passOpen.set(false);
  }

  saveQr() {
    const member = this.createdMember();
    const qr = this.qrCode();
    if (!member || !qr) {
      return;
    }
    const link = document.createElement('a');
    link.href = qr;
    link.download = `${member.id}.png`;
    link.click();
  }

  emailQr() {
    const member = this.createdMember();
    if (!member) {
      return;
    }

    this.emailing.set(true);
    this.emailNotice.set('');
    this.api.emailMemberQr(member.id).subscribe({
      next: () => {
        this.emailing.set(false);
        this.emailNotice.set(`QR sent to ${member.email}.`);
      },
      error: () => {
        this.emailing.set(false);
        this.openMailto(member);
        this.emailNotice.set(
          'No mail server is configured yet, so your email app was opened instead. Attach the saved QR if needed.',
        );
      },
    });
  }

  async openScanner() {
    this.scanError.set('');
    this.scanOpen.set(true);
    afterNextRender(
      () => {
        void this.startScanner();
      },
      { injector: this.injector },
    );
  }

  async closeScanner() {
    await this.stopScanner();
    this.scanOpen.set(false);
  }

  async scanQrFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    this.scanError.set('');
    try {
      const hostId = this.scannerHost()?.nativeElement.id ?? 'qr-reader';
      await this.stopScanner();
      this.scanner = new Html5Qrcode(hostId);
      const text = await this.scanner.scanFile(file, false);
      input.value = '';
      await this.onScan(text);
    } catch (error) {
      input.value = '';
      const detail = error instanceof Error ? error.message : 'Could not read a member ID from that image.';
      this.scanError.set(detail);
    }
  }

  closeExpired() {
    this.expiredOpen.set(false);
    this.expiredMember.set(null);
  }

  private async startScanner() {
    const host = this.scannerHost()?.nativeElement;
    if (!host || this.scanning) {
      return;
    }

    try {
      this.scanner = new Html5Qrcode(host.id);
      this.scanning = true;
      await this.scanner.start(
        { facingMode: 'environment' },
        { fps: 8, qrbox: { width: 240, height: 240 } },
        (text) => {
          void this.onScan(text);
        },
        () => undefined,
      );
    } catch {
      this.scanning = false;
      this.scanError.set('Camera access is required to scan a member QR.');
    }
  }

  private async stopScanner() {
    if (!this.scanner) {
      this.scanning = false;
      return;
    }
    try {
      if (this.scanning) {
        await this.scanner.stop();
      }
    } catch {
      // Scanner may already be stopped.
    }
    try {
      this.scanner.clear();
    } catch {
      // Ignore cleanup races when the modal closes.
    }
    this.scanner = null;
    this.scanning = false;
  }

  private async onScan(raw: string) {
    if (this.handlingScan) {
      return;
    }
    this.handlingScan = true;
    const memberId = raw.trim().toUpperCase();
    await this.stopScanner();
    this.scanOpen.set(false);

    this.api.checkIn(memberId).subscribe({
      next: ({ checkIn, member }) => {
        this.checkIns.update((rows) => [checkIn, ...rows]);
        this.notice.set(`${member.name} checked in at ${new Date(checkIn.checkedInAt).toLocaleString()}.`);
        if (member.membershipStatus === 'expired') {
          this.expiredMember.set(member);
          this.expiredOpen.set(true);
        }
        this.handlingScan = false;
      },
      error: (error: HttpErrorResponse) => {
        this.notice.set('');
        this.scanError.set(this.errorMessage(error, 'Could not log this check-in.'));
        this.scanOpen.set(true);
        this.handlingScan = false;
        afterNextRender(
          () => {
            void this.startScanner();
          },
          { injector: this.injector },
        );
      },
    });
  }

  private openMailto(member: Member) {
    const subject = encodeURIComponent(`Your GymPass QR — ${member.id}`);
    const body = encodeURIComponent(
      `Hi ${member.name},\n\nYour GymPass member ID is ${member.id}. Save the QR image from the gym desk and present it at check-in.\nMembership expires on ${member.expiresOn}.\n`,
    );
    window.location.href = `mailto:${member.email}?subject=${subject}&body=${body}`;
  }

  private defaultExpiry() {
    const date = new Date();
    date.setDate(date.getDate() + 30);
    return date.toISOString().slice(0, 10);
  }

  private errorMessage(error: HttpErrorResponse, fallback: string) {
    const message = error.error?.error;
    return typeof message === 'string' ? message : fallback;
  }
}
