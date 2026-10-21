import { HttpInterceptorFn } from '@angular/common/http';

export const ownerKeyInterceptor: HttpInterceptorFn = (req, next) => {
  const key = sessionStorage.getItem('ownerKey');
  if (key && req.url.startsWith('/api')) {
    req = req.clone({ setHeaders: { 'x-owner-key': key } });
  }
  return next(req);
};