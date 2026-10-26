import { Component, inject, signal } from '@angular/core';
import { AuthService } from './auth';
import { SyncService } from './sync';

@Component({
  selector: 'app-unlock',
  template: `
    <main class="unlock">
      <p class="eyebrow">Access required</p>
      <h1>GymPass</h1>
      <p class="lede">Enter the access key shown on the computer that runs GymPass (or run <code>npm run key</code> there).</p>
      <form (submit)="submit($event, field.value)">
        <input
          #field
          class="field"
          name="gympass-key"
          placeholder="XXXX-XXXX-XXXX"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          aria-label="Access key"
        />
        <button type="submit" class="btn" [disabled]="busy()">{{ busy() ? 'Checking…' : 'Unlock' }}</button>
      </form>
      @if (error() || auth.notice()) {
        <p class="error" role="alert">{{ error() || auth.notice() }}</p>
      }
    </main>
  `,
  styles: `
    .unlock { max-width: 28rem; margin: 0 auto; padding: 4rem 1.25rem; }
    h1 { margin: 0.2rem 0 0.6rem; font-size: 3rem; letter-spacing: -0.04em; }
    .eyebrow { margin: 0; color: #7dffb3; font-weight: 700; text-transform: uppercase; letter-spacing: 0.16em; font-size: 0.78rem; }
    .lede { color: #c5d4cc; }
    code { background: #14241d; padding: 0.1rem 0.4rem; border-radius: 0.4rem; }
    form { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1.5rem; }
    .field { padding: 0.9rem 1rem; border-radius: 0.9rem; border: 1px solid #3d5a4d; background: #0f1d17; color: #e8f3ed; font-size: 1.2rem; letter-spacing: 0.12em; text-align: center; text-transform: uppercase; }
    .btn { border: 0; border-radius: 999px; padding: 0.9rem 1.35rem; font-weight: 700; background: #7dffb3; color: #10231c; cursor: pointer; }
    .btn:disabled { opacity: 0.6; cursor: wait; }
    .error { color: #ff9b9b; }
  `,
})
export class Unlock {
  readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(event: Event, value: string) {
    event.preventDefault();
    this.error.set('');
    this.busy.set(true);
    try {
      await this.auth.unlock(value);
      void this.sync.syncNow();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Could not unlock.');
    } finally {
      this.busy.set(false);
    }
  }
}
