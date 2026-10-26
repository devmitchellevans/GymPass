import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
// ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) =>
//   document.addEventListener(type, (e) => e.preventDefault()),
// );