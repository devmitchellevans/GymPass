import { Routes } from '@angular/router';
import { Home } from './home';

export const routes: Routes = [
  { path: '', component: Home, pathMatch: 'full' },
  { path: 'members', loadComponent: () => import('./members').then((m) => m.Members) },
  // Lazy so the admin view does not pay for kiosk code (and vice versa).
  { path: 'kiosk', loadComponent: () => import('./kiosk').then((m) => m.Kiosk) },
  { path: '**', redirectTo: '' },
];
