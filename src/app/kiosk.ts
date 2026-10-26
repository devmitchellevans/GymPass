import { AfterViewInit, Component, computed, ElementRef, inject, OnDestroy, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Html5Qrcode } from 'html5-qrcode';
import { GymStore } from './gym-store';
import { looksLikeMemberId } from './ids';
import { Member } from './models';
import { SyncStatusChip } from './sync-status';

interface KioskResult {
  tone: 'ok' | 'expired' | 'error';
  title: string;
  detail: string;
}

/** Same member scanned again within this window is ignored (QR still held in front of the camera). */
const DEDUPE_MS = 60_000;
const RESULT_MS = 3500;
/** After a result disappears, the same QR still held up is ignored this long (avoids a message loop). */
const SAME_QR_COOLDOWN_MS = 6000;

/**
 * Self-service check-in screen: opens straight into the camera, shows a big result, then resets.
 * Works fully offline. Open it at /kiosk (also available as an installed-app shortcut).
 *
 * Future hooks: staff PIN to exit, per-device label, remote config, auto-reload on idle.
 */
@Component({
  selector: 'app-kiosk',
  imports: [RouterLink, SyncStatusChip],
  template: `
    <main class="kiosk">
      <header>
        <h1>GymPass</h1>
        <app-sync-status />
      </header>

      <p class="prompt">Hold your QR code up to the camera</p>
      <div id="kiosk-reader" #host class="reader"></div>
      @if (cameraError()) {
        <p class="error">{{ cameraError() }}</p>
        <button type="button" class="btn" (click)="start()">Retry camera</button>
      }

      @if (cameraOk() || manualOpen()) {
        <button type="button" class="btn alt" (click)="toggleManual()">
          {{ manualOpen() ? 'Hide' : nameLookup ? 'No QR? Use your name or ID' : 'No QR? Use your member ID' }}
        </button>
      }
      @if (manualOpen()) {
        <section class="manual" aria-label="Check in with name or ID">
          <label>
            {{ nameLookup ? 'Your name or member ID' : 'Your member ID' }}
            <input
              #manualInput
              class="field"
              [value]="typed()"
              (input)="onType($event)"
              (keydown.enter)="submitTyped()"
              [placeholder]="nameLookup ? 'Start typing your name…' : 'GP-XXXXXXXX'"
              autocomplete="off"
              autocapitalize="words"
              spellcheck="false"
            />
          </label>
          @if (matches().length) {
            <ul class="matches">
              @for (m of matches(); track m.id) {
                <li>
                  <button type="button" (click)="pick(m)">
                    {{ m.name }} <small>· ID ends {{ m.id.slice(-4) }}</small>
                  </button>
                </li>
              }
            </ul>
          } @else if (nameLookup && typed().trim().length >= 3 && !isId()) {
            <p class="hint">No name matches. Try more of your name, or type your member ID.</p>
          } @else if (nameLookup && typed().trim().length > 0 && typed().trim().length < 3 && !isId()) {
            <p class="hint">Keep typing…</p>
          }
          <button type="button" class="btn" (click)="submitTyped()">Check in</button>
        </section>
      }

      @if (result(); as r) {
        <div class="overlay" [class]="r.tone" role="status" aria-live="assertive">
          <h2>{{ r.title }}</h2>
          <p>{{ r.detail }}</p>
        </div>
      }

      <footer>
        <button type="button" class="link" (click)="toggleFullscreen()">Fullscreen</button>
        <a routerLink="/" class="link">Staff · exit kiosk</a>
      </footer>
    </main>
  `,
  styles: `
    :host { display: block; min-height: 100vh; }
    .kiosk { min-height: 100vh; display: flex; flex-direction: column; align-items: center; gap: 1.25rem; padding: 1.5rem; }
    header { width: 100%; max-width: 40rem; display: flex; justify-content: space-between; align-items: center; }
    h1 { margin: 0; font-size: 2rem; letter-spacing: -0.03em; }
    .prompt { font-size: clamp(1.3rem, 4vw, 2rem); font-weight: 700; margin: 0.5rem 0; text-align: center; }
    .reader { width: min(90vw, 34rem); border-radius: 1.5rem; overflow: hidden; background: #000; min-height: 18rem; }
    .error { color: #ff9b9b; text-align: center; }
    .btn { border: 0; border-radius: 999px; padding: 0.9rem 1.4rem; font-weight: 700; background: #7dffb3; color: #10231c; cursor: pointer; }
    footer { margin-top: auto; width: 100%; max-width: 40rem; display: flex; justify-content: space-between; opacity: 0.6; }
    .link { background: none; border: 0; color: #c5d4cc; font: inherit; cursor: pointer; text-decoration: underline; }
    .btn.alt { background: transparent; color: #e8f3ed; box-shadow: inset 0 0 0 2px #3d5a4d; }
    .manual { width: min(90vw, 34rem); display: grid; gap: 0.75rem; }
    .manual label { display: grid; gap: 0.4rem; font-size: 1.05rem; }
    .field { padding: 0.9rem 1rem; border-radius: 0.9rem; border: 1px solid #3d5a4d; background: #0f1d17; color: #e8f3ed; font: inherit; font-size: 1.25rem; }
    .matches { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
    .matches button { width: 100%; text-align: left; padding: 1rem 1.1rem; font: inherit; font-size: 1.2rem; font-weight: 700; border-radius: 0.9rem; border: 1px solid #3d5a4d; background: #14241d; color: #e8f3ed; cursor: pointer; }
    .matches small { color: #93a89c; font-weight: 400; }
    .hint { margin: 0; color: #c5d4cc; }
    .overlay {
      position: fixed; inset: 0; display: grid; place-content: center; text-align: center; padding: 2rem; z-index: 20;
      color: #fff; background: #0a7a3f;
    }
    .overlay.expired { background: #b36b00; }
    .overlay.error { background: #a32222; }
    .overlay h2 { margin: 0; font-size: clamp(2.4rem, 9vw, 5rem); }
    .overlay p { font-size: clamp(1.2rem, 4vw, 2rem); margin: 1rem 0 0; }
  `,
})
export class Kiosk implements AfterViewInit, OnDestroy {
  private readonly store = inject(GymStore);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  private scanner: Html5Qrcode | null = null;
  private busy = false;
  private lastCameraText = '';
  private lastResultEndedAt = 0;
  private wakeLock: { release(): Promise<void> } | null = null;
  private resultTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') void this.keepAwake();
  };

  /**
   * /kiosk?lookup=id turns off name suggestions, so only someone who knows their member ID can use
   * the typed option (stricter for a screen that strangers can touch).
   */
  readonly nameLookup = inject(ActivatedRoute).snapshot.queryParamMap.get('lookup') !== 'id';
  private readonly host2 = viewChild<ElementRef<HTMLInputElement>>('manualInput');

  readonly result = signal<KioskResult | null>(null);
  readonly cameraError = signal('');
  readonly cameraOk = signal(true);
  readonly manualOpen = signal(false);
  readonly typed = signal('');
  readonly isId = computed(() => looksLikeMemberId(this.typed()));
  /** Only after 3+ letters, max 5 suggestions, name only: avoids showing the whole member list on a public screen. */
  readonly matches = computed<Member[]>(() => {
    const q = this.typed().trim().toLowerCase();
    if (!this.nameLookup || q.length < 3 || this.isId()) return [];
    return this.store
      .members()
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, 5);
  });

  ngAfterViewInit() {
    void this.start();
    void this.keepAwake();
    document.addEventListener('visibilitychange', this.onVisible);
  }

  ngOnDestroy() {
    clearTimeout(this.resultTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    void this.wakeLock?.release().catch(() => undefined);
    void this.stop();
  }

  async start() {
    this.cameraError.set('');
    this.cameraOk.set(true);
    await this.stop();
    const config = { fps: 10, qrbox: { width: 260, height: 260 } };
    const onScan = (text: string) => {
      if (text === this.lastCameraText && Date.now() - this.lastResultEndedAt < SAME_QR_COOLDOWN_MS) return;
      this.lastCameraText = text;
      void this.handle(text);
    };
    this.scanner = new Html5Qrcode(this.host().nativeElement.id);
    try {
      await this.scanner.start({ facingMode: 'environment' }, config, onScan, () => undefined);
    } catch {
      try {
        // Wall-mounted tablets often only have the front camera.
        await this.scanner.start({ facingMode: 'user' }, config, onScan, () => undefined);
      } catch {
        this.cameraOk.set(false);
        this.cameraError.set(
          'Camera unavailable. You can still check in with your name or ID below, or allow camera access (needs HTTPS or localhost) and tap Retry.',
        );
        this.manualOpen.set(true);
      }
    }
  }

  toggleManual() {
    this.manualOpen.update((open) => !open);
    this.typed.set('');
    if (this.manualOpen()) {
      setTimeout(() => this.host2()?.nativeElement.focus());
    }
  }

  onType(event: Event) {
    this.typed.set((event.target as HTMLInputElement).value);
  }

  pick(member: Member) {
    void this.handle(member.id);
  }

  submitTyped() {
    const raw = this.typed().trim();
    if (!raw) return;
    if (this.isId()) {
      void this.handle(raw);
    } else if (this.matches().length === 1) {
      void this.handle(this.matches()[0].id);
    } else if (this.matches().length > 1) {
      this.show({ tone: 'error', title: 'Which one is you?', detail: 'Tap your name in the list.' });
    } else {
      this.show({
        tone: 'error',
        title: this.nameLookup ? 'No match' : 'ID not recognised',
        detail: this.nameLookup ? 'Try more of your name, or type your member ID.' : 'Check the ID and try again.',
      });
    }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
    }
  }

  private async handle(text: string) {
    if (this.busy) return;
    this.busy = true;
    this.typed.set('');
    try {
      const { member, duplicate } = await this.store.checkIn(text, { dedupeMs: DEDUPE_MS });
      if (duplicate) {
        this.show({ tone: 'ok', title: 'Already checked in', detail: `${member.name}, you're all set.` });
      } else if (member.membershipStatus === 'expired') {
        this.show({
          tone: 'expired',
          title: 'Membership expired',
          detail: `${member.name} — ended ${member.expiresOn}. Please see the front desk.`,
        });
      } else {
        this.show({ tone: 'ok', title: `Welcome, ${member.name}`, detail: 'Check-in recorded.' });
      }
    } catch (error) {
      this.show({
        tone: 'error',
        title: 'Not recognised',
        detail: error instanceof Error ? error.message : 'Please see the front desk.',
      });
    }
  }

  private show(result: KioskResult) {
    this.result.set(result);
    clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(() => {
      this.result.set(null);
      this.lastResultEndedAt = Date.now();
      this.busy = false;
    }, RESULT_MS);
  }

  private async stop() {
    const scanner = this.scanner;
    this.scanner = null;
    if (!scanner) return;
    try {
      await scanner.stop();
    } catch {
      /* not running */
    }
    try {
      scanner.clear();
    } catch {
      /* ignore */
    }
  }

  private async keepAwake() {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
      this.wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      /* unsupported or denied: the kiosk still works, the screen may dim */
    }
  }
}
