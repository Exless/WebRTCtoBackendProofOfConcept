import { Component } from '@angular/core';
import { CameraManagerComponent } from './components/camera-manager.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CameraManagerComponent],
  template: `<app-camera-manager />`
})
export class App { }
