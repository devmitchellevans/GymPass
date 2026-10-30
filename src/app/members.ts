import { DatePipe, TitleCasePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GymApi } from './gym-api';
import { GymStore, MemberHistory, memberQrDataUrl } from './gym-store';
import { addDaysLocal, addMonthsLocal, todayLocalDate } from './ids';
import { Member } from './models';
import { SyncService } from './sync';
import { SyncStatusChip } from './sync-status';

type Filter = 'all' | 'active' | 'expired';

// Same rule the server applies, so a member can never be saved here and then refused on sync.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function dataUrlToFile(dataUrl: string, name: string): File {
  const binary = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: 'image/png' });
}

/** Members: the one place to view, search, add, edit and delete members and issue QR passes. */
@Component({
  selector: 'app-members',
  imports: [DatePipe, ReactiveFormsModule, RouterLink, SyncStatusChip, TitleCasePipe],
  templateUrl: './members.html',
  styleUrls: ['./ui.css', './members.css'],
})
export class Members {
  private readonly fb = inject(FormBuilder);
  private readonly store = inject(GymStore);
  private readonly api = inject(GymApi);
  readonly sync = inject(SyncService);

  // ---- list ----
  readonly query = signal('');
  readonly filter = signal<Filter>('all');
  readonly counts = this.store.counts;
  readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    const f = this.filter();
    return this.store.members().filter((m) => {
      if (f !== 'all' && m.membershipStatus !== f) return false;
      if (!q) return true;
      return [m.name, m.id, m.email, m.contactNumber].some((v) => v.toLowerCase().includes(q));
    });
  });
  readonly notice = signal('');

  // ---- add / edit form ----
  readonly formOpen = signal(false);
  readonly editing = signal<Member | null>(null);
  readonly saving = signal(false);
  readonly formError = signal('');
  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    contactNumber: ['', [Validators.required, Validators.maxLength(40)]],
    email: ['', [Validators.required, Validators.pattern(EMAIL_PATTERN)]],
    expiresOn: ['', Validators.required],
  });

  // ---- profile ----
  private readonly profileId = signal<string | null>(null);
  readonly profile = computed(() => this.store.members().find((m) => m.id === this.profileId()) ?? null);
  readonly history = signal<MemberHistory | null>(null);

  // ---- QR pass + email ----
  readonly passMember = signal<Member | null>(null);
  readonly qrCode = signal('');
  readonly emailing = signal(false);
  readonly passNotice = signal('');
  readonly emailFallback = signal(false);
  readonly canShareFiles = (() => {
    try {
      return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] });
    } catch {
      return false;
    }
  })();

  /** iOS (Safari and installed web apps) ignores "download" links, so saving goes through the share sheet. */
  private readonly isIos =
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);
  /** True when this page is on a secure connection (https or localhost), which the share sheet requires. */
  readonly secure = window.isSecureContext;

  /**
   * A real <a href="mailto:…"> that the person taps (phones block mail links opened from code).
   * Web pages cannot attach files to these, so the draft carries the ID; use Share… to attach the picture.
   */
  readonly mailtoHref = computed(() => {
    const m = this.passMember();
    if (!m) return '';
    const subject = encodeURIComponent(`Your GymPass QR — ${m.id}`);
    const body = encodeURIComponent(
      `Hi ${m.name},\n\nYour GymPass member ID is ${m.id}.\nMembership expires on ${m.expiresOn}.\n\nPresent your QR code at the gym to check in.`,
    );
    return `mailto:${m.email}?subject=${subject}&body=${body}`;
  });

  // ---- delete ----
  readonly deleteTarget = signal<Member | null>(null);
  readonly deleting = signal(false);

  readonly today = todayLocalDate();

  onSearch(event: Event) {
    this.query.set((event.target as HTMLInputElement).value);
  }

  // ===================== add / edit =====================
  openAdd() {
    this.notice.set('');
    this.editing.set(null);
    this.form.reset({ name: '', contactNumber: '', email: '', expiresOn: addMonthsLocal(todayLocalDate(), 1) });
    this.formError.set('');
    this.formOpen.set(true);
  }

  openEdit(member: Member) {
    this.notice.set('');
    this.profileId.set(null);
    this.editing.set(member);
    this.form.reset({
      name: member.name,
      contactNumber: member.contactNumber,
      email: member.email,
      expiresOn: member.expiresOn,
    });
    this.formError.set('');
    this.formOpen.set(true);
  }

  closeForm() {
    this.formOpen.set(false);
  }

  /** Renew from the later of today and the current expiry, so early renewals do not lose days. */
  extend(months: number) {
    const current = this.form.controls.expiresOn.value;
    const base = current && current >= todayLocalDate() ? current : todayLocalDate();
    this.form.controls.expiresOn.setValue(addMonthsLocal(base, months));
  }

  expireNow() {
    this.form.controls.expiresOn.setValue(addDaysLocal(todayLocalDate(), -1));
  }

  formStatus(): 'active' | 'expired' {
    return (this.form.controls.expiresOn.value || '0') >= todayLocalDate() ? 'active' : 'expired';
  }

  async save() {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.formError.set('Please fill in every field. The email must look like name@example.com.');
      return;
    }
    this.saving.set(true);
    this.formError.set('');
    const value = this.form.getRawValue();
    const editing = this.editing();
    try {
      if (editing) {
        const saved = await this.store.updateMember(editing.id, value);
        this.formOpen.set(false);
        this.notice.set(`Saved changes for ${saved.name}.`);
      } else {
        const { member, qrCode } = await this.store.createMember(value);
        this.formOpen.set(false);
        this.showPass(member, qrCode);
        if (!this.sync.reachable()) {
          this.passNotice.set('Saved on this device. It will upload automatically when you are back online.');
        }
      }
    } catch (error) {
      this.formError.set(error instanceof Error ? error.message : 'Could not save this member.');
    } finally {
      this.saving.set(false);
    }
  }

  // ===================== profile =====================
  async openProfile(member: Member) {
    this.notice.set('');
    this.history.set(null);
    this.profileId.set(member.id);
    this.history.set(await this.store.memberHistory(member.id));
  }

  closeProfile() {
    this.profileId.set(null);
  }

  // ===================== delete =====================
  askDelete(member: Member) {
    this.profileId.set(null);
    this.deleteTarget.set(member);
  }

  async confirmDelete() {
    const member = this.deleteTarget();
    if (!member) return;
    this.deleting.set(true);
    try {
      await this.store.deleteMember(member.id);
      this.notice.set(`${member.name} was deleted. Past check-ins stay in the log.`);
    } finally {
      this.deleting.set(false);
      this.deleteTarget.set(null);
    }
  }

  // ===================== QR pass + email =====================
  async openPass(member: Member) {
    this.profileId.set(null);
    this.showPass(member, await memberQrDataUrl(member.id));
  }

  private showPass(member: Member, qrCode: string) {
    this.passMember.set(member);
    this.qrCode.set(qrCode);
    this.passNotice.set('');
    this.emailFallback.set(false);
  }

  closePass() {
    this.passMember.set(null);
  }

  /**
   * Saves the QR picture. Desktop and Android download it; iPhone/iPad open the share sheet
   * (choose "Save Image" to keep it in Photos, or Mail/Gmail/Messages to send it).
   */
  async saveQr() {
    const member = this.passMember();
    if (!member) return;
    if (this.isIos) {
      if (this.canShareFiles) {
        await this.shareQr();
      } else {
        this.passNotice.set('Press and hold the QR picture, then choose “Save to Photos”.');
      }
      return;
    }
    const file = dataUrlToFile(this.qrCode(), `${member.id}.png`);
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15_000);
    this.passNotice.set(`Saved ${file.name}. Check your Downloads folder.`);
  }

  /** Server email: the QR is both shown in the message and attached as a PNG file. */
  emailQr() {
    const member = this.passMember();
    if (!member) return;
    this.emailing.set(true);
    this.passNotice.set('');
    this.emailFallback.set(false);
    // The server can only email a member it already knows, so push pending changes first.
    void this.sync.syncNow().then(() => {
      this.api.emailMemberQr(member.id).subscribe({
        next: () => {
          this.emailing.set(false);
          this.passNotice.set(`Email sent to ${member.email} with the QR image attached.`);
        },
        error: (error: HttpErrorResponse) => {
          this.emailing.set(false);
          this.emailFallback.set(true);
          const serverReason = typeof error.error?.error === 'string' ? error.error.error : '';
          this.passNotice.set(
            error.status === 503
              ? 'The server has no email account set up yet, so it cannot send the email itself.'
              : error.status === 502 && serverReason
                ? serverReason
                : 'Could not reach the server to send the email (you may be offline).',
          );
        },
      });
    });
  }

  /** Phones and some desktops can hand the PNG itself to the mail app, with the image attached. */
  async shareQr() {
    const member = this.passMember();
    if (!member) return;
    try {
      await navigator.share({
        files: [dataUrlToFile(this.qrCode(), `${member.id}.png`)],
        title: `GymPass QR for ${member.name}`,
        text: `Hi ${member.name}, your GymPass member ID is ${member.id}. Your QR code is attached.`,
      });
    } catch (error) {
      if ((error as DOMException)?.name !== 'AbortError') {
        this.passNotice.set('Sharing is not available on this device or connection. Save the QR and attach it yourself.');
      }
    }
  }
}
