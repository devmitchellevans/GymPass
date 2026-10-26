import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { vi } from 'vitest';
import { App } from './app';
import { AuthService } from './auth';
import { GYM_DB } from './db';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    // No server in unit tests: every sync attempt fails, which is exactly the "offline" case.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
    }).compileComponents();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('asks for the access key when the device is not unlocked', async () => {
    await GYM_DB.meta.delete('accessKey');
    await TestBed.inject(AuthService).load();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('app-unlock')).toBeTruthy();
    expect(el.querySelector('app-home')).toBeNull();
  });

  it('should render GymPass', async () => {
    await GYM_DB.setMeta('accessKey', 'TEST-KEY');
    await TestBed.inject(AuthService).load();
    const fixture = TestBed.createComponent(App);
    await TestBed.inject(Router).navigateByUrl('/');
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('GymPass');
  });
});
