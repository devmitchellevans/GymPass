import { Component } from '@angular/core';
import { Home } from './home';

@Component({
  selector: 'app-root',
  imports: [Home],
  template: '<app-home />',
})
export class App {}
