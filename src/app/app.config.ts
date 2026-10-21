import { provideHttpClient, withFetch,withInterceptors} from '@angular/common/http';
import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { ownerKeyInterceptor } from './owner-key.interceptor';
export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([ownerKeyInterceptor])),
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withFetch()),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
