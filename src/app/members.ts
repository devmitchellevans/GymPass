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
  readonly emailNotice = signal('');
  readonly emailFallback = signal(false);
  readonly canShareFiles = (() => {
    try {
      return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] });
    } catch {
      return false;
    }
  })();

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
          this.emailNotice.set('Saved on this device. It will upload automatically when you are back online.');
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
    this.emailNotice.set('');
    this.emailFallback.set(false);
  }

  closePass() {
    this.passMember.set(null);
  }

  saveQr() {
    const member = this.passMember();
    if (!member) return;
    const link = document.createElement('a');
    link.href = this.qrCode();
    link.download = `${member.id}.png`;
    link.click();
  }

  /** Server email: the QR is both shown in the message and attached as a PNG file. */
  emailQr() {
    const member = this.passMember();
    if (!member) return;
    this.emailing.set(true);
    this.emailNotice.set('');
    this.emailFallback.set(false);
    // The server can only email a member it already knows, so push pending changes first.
    void this.sync.syncNow().then(() => {
      this.api.emailMemberQr(member.id).subscribe({
        next: () => {
          this.emailing.set(false);
          this.emailNotice.set(`Email sent to ${member.email} with the QR image attached.`);
        },
        error: (error: HttpErrorResponse) => {
          this.emailing.set(false);
          this.emailFallback.set(true);
          this.emailNotice.set(
            error.status === 503
              ? 'The server has no email account set up yet, so it cannot send the email itself. You can still send the QR image another way:'
              : 'Could not send from the server (you may be offline). You can still send the QR image another way:',
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
        this.emailNotice.set('Sharing is not available here. Use “Open email app” instead.');
      }
    }
  }

  /** Last resort: a web page cannot attach files to mailto: links, so the PNG is saved for you to attach. */
  openMailApp() {
    const member = this.passMember();
    if (!member) return;
    this.saveQr();
    const subject = encodeURIComponent(`Your GymPass QR — ${member.id}`);
    const body = encodeURIComponent(
      `Hi ${member.name},\n\nYour GymPass member ID is ${member.id}.\nMembership expires on ${member.expiresOn}.\n\n(Attach the QR image ${member.id}.png that was just saved to your Downloads folder.)`,
    );
    window.location.href = `mailto:${encodeURIComponent(member.email)}?subject=${subject}&body=${body}`;
    this.emailNotice.set(`The image ${member.id}.png was saved to your Downloads folder. Attach it to the email that just opened.`);
  }
}
