import { Component, signal, computed, OnInit, OnDestroy, ElementRef, ViewChildren, QueryList, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WebRtcService, ConnectionState } from '../services/webrtc.service';

interface CameraInfo {
  deviceId: string;
  label: string;
  stream: MediaStream | null;
  resolution?: { width: number; height: number };
}

interface ToastMessage {
  id: number;
  type: 'success' | 'error' | 'info';
  title: string;
  message: string;
}

@Component({
  selector: 'app-camera-manager',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="camera-manager">
      <!-- Flash Overlay -->
      @if (isFlashing()) {
        <div class="flash-overlay"></div>
      }

      <!-- Toast Container -->
      <div class="toast-container">
        @for (toast of toasts(); track toast.id) {
          <div class="toast" [class]="toast.type" (click)="removeToast(toast.id)">
            <span class="toast-icon">
              @switch (toast.type) {
                @case ('success') { ✅ }
                @case ('error') { ❌ }
                @case ('info') { ℹ️ }
              }
            </span>
            <div class="toast-content">
              <div class="toast-title">{{ toast.title }}</div>
              <div class="toast-message">{{ toast.message }}</div>
            </div>
          </div>
        }
      </div>

      <!-- Header -->
      <header class="header">
        <div class="header-content">
          <h1 class="title">
            <span class="title-icon">📷</span>
            Multi-Webcam Snapshot
          </h1>
          <div class="connection-status" [class]="connectionState()">
            <span class="status-dot"></span>
            <span class="status-text">{{ connectionStatusText() }}</span>
          </div>
        </div>
      </header>

      <!-- Controls -->
      <div class="controls">
        <button 
          class="btn btn-primary"
          [disabled]="connectionState() === 'connecting'"
          (click)="toggleConnection()">
          @if (connectionState() === 'disconnected' || connectionState() === 'failed' || connectionState() === 'closed') {
            <span class="btn-icon">🔌</span> Connect
          } @else if (connectionState() === 'connecting') {
            <span class="btn-icon spinning">⏳</span> Connecting...
          } @else {
            <span class="btn-icon">❌</span> Disconnect
          }
        </button>

        <button 
          class="btn btn-success"
          [disabled]="!canCapture()"
          (click)="captureAndSend()">
          @if (isSending()) {
            <span class="btn-icon spinning">📤</span> Sending... {{ sendProgress().toFixed(0) }}%
          } @else {
            <span class="btn-icon">📸</span> Capture & Send
          }
        </button>

        <button 
          class="btn btn-secondary"
          [disabled]="isEnumerating()"
          (click)="enumerateCameras()">
          <span class="btn-icon">🔄</span> Refresh Cameras
        </button>
      </div>

      <!-- Camera info -->
      <div class="camera-info">
        <span class="camera-count">
          {{ activeStreams().length }} camera(s) active
        </span>
        @if (activeStreams().length === 0) {
          <span class="no-cameras-hint">Click "Refresh Cameras" to detect connected webcams</span>
        }
      </div>

      <!-- Camera Grid -->
      <div class="camera-grid" [class.cameras-loaded]="activeStreams().length > 0">
        @for (camera of cameras(); track camera.deviceId; let i = $index) {
          <div class="camera-card" 
               [class.active]="camera.stream !== null"
               [class.capturing]="capturingCameras().includes(camera.deviceId)">
            <div class="camera-header">
              <span class="camera-label">{{ camera.label || 'Camera ' + i }}</span>
              <div class="camera-meta">
                @if (camera.resolution) {
                  <span class="resolution-badge">{{ camera.resolution.width }}×{{ camera.resolution.height }}</span>
                }
                <span class="camera-badge">CAM {{ i + 1 }}</span>
              </div>
            </div>
            <div class="video-container">
              <!-- Always render video element, control visibility with stream -->
              <video 
                #videoElement
                [attr.data-device-id]="camera.deviceId"
                [srcObject]="camera.stream"
                [style.display]="camera.stream ? 'block' : 'none'"
                autoplay 
                playsinline 
                muted>
              </video>
              <!-- Individual camera flash -->
              @if (camera.stream) {
                <div class="camera-flash" [class.active]="capturingCameras().includes(camera.deviceId)"></div>
              }
              @if (!camera.stream) {
                <div class="video-placeholder">
                  <span class="placeholder-icon">📹</span>
                  <span class="placeholder-text">Camera not active</span>
                </div>
              }
            </div>
          </div>
        }

        @if (cameras().length === 0) {
          <div class="no-cameras">
            <div class="no-cameras-icon">🎥</div>
            <div class="no-cameras-title">No Cameras Detected</div>
            <div class="no-cameras-text">
              Connect up to 5 webcams and click "Refresh Cameras" to start
            </div>
          </div>
        }
      </div>

      <!-- Hidden canvases for snapshot capture -->
      <div class="hidden-canvases" style="display: none;">
        @for (camera of cameras(); track camera.deviceId) {
          <canvas #canvasElement [attr.data-device-id]="camera.deviceId"></canvas>
        }
      </div>
    </div>
  `,
  styles: [`
    .camera-manager {
      min-height: 100vh;
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
      color: #e4e4e7;
      padding: 2rem;
      position: relative;
    }

    /* Flash Overlay */
    .flash-overlay {
      position: fixed;
      inset: 0;
      background: white;
      z-index: 9999;
      animation: flash 0.3s ease-out forwards;
      pointer-events: none;
    }

    @keyframes flash {
      0% { opacity: 0.8; }
      100% { opacity: 0; }
    }

    /* Toast Notifications */
    .toast-container {
      position: fixed;
      top: 1.5rem;
      right: 1.5rem;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      max-width: 400px;
    }

    .toast {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      border-radius: 0.75rem;
      background: rgba(30, 30, 50, 0.95);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
      cursor: pointer;
      animation: slideIn 0.3s ease-out;
      transition: all 0.2s ease;
    }

    .toast:hover {
      transform: translateX(-4px);
      border-color: rgba(255, 255, 255, 0.2);
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(100%);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .toast.success {
      border-left: 4px solid #22c55e;
    }

    .toast.error {
      border-left: 4px solid #ef4444;
    }

    .toast.info {
      border-left: 4px solid #3b82f6;
    }

    .toast-icon {
      font-size: 1.5rem;
      flex-shrink: 0;
    }

    .toast-content {
      flex: 1;
    }

    .toast-title {
      font-weight: 600;
      font-size: 0.95rem;
      color: #f4f4f5;
      margin-bottom: 0.25rem;
    }

    .toast-message {
      font-size: 0.85rem;
      color: #a1a1aa;
      line-height: 1.4;
    }

    /* Camera Flash Effect */
    .camera-flash {
      position: absolute;
      inset: 0;
      background: white;
      opacity: 0;
      pointer-events: none;
      z-index: 10;
    }

    .camera-flash.active {
      animation: cameraFlash 0.4s ease-out;
    }

    @keyframes cameraFlash {
      0% { opacity: 0.9; }
      50% { opacity: 0.5; }
      100% { opacity: 0; }
    }

    .camera-card.capturing {
      animation: captureRing 0.5s ease-out;
    }

    @keyframes captureRing {
      0% { 
        box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7);
      }
      70% {
        box-shadow: 0 0 0 15px rgba(34, 197, 94, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);
      }
    }

    .header {
      margin-bottom: 2rem;
    }

    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .title {
      font-size: 2rem;
      font-weight: 700;
      background: linear-gradient(135deg, #00d4ff, #7c3aed);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin: 0;
    }

    .title-icon {
      font-size: 2.5rem;
    }

    .connection-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      border-radius: 2rem;
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ef4444;
      animation: pulse 2s infinite;
    }

    .connection-status.connected .status-dot {
      background: #22c55e;
    }

    .connection-status.connecting .status-dot {
      background: #f59e0b;
    }

    .connection-status.failed .status-dot {
      background: #ef4444;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .controls {
      display: flex;
      gap: 1rem;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }

    .btn {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1.5rem;
      border: none;
      border-radius: 0.75rem;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-primary {
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(124, 58, 237, 0.4);
    }

    .btn-success {
      background: linear-gradient(135deg, #059669, #10b981);
      color: white;
    }

    .btn-success:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(16, 185, 129, 0.4);
    }

    .btn-secondary {
      background: linear-gradient(135deg, #3b82f6, #60a5fa);
      color: white;
    }

    .btn-secondary:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(59, 130, 246, 0.4);
    }

    .btn-icon {
      font-size: 1.2rem;
    }

    .spinning {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .camera-info {
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .camera-count {
      font-size: 1.1rem;
      color: #00d4ff;
      font-weight: 600;
    }

    .no-cameras-hint {
      color: #a1a1aa;
      font-size: 0.9rem;
    }

    .camera-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1.5rem;
    }

    .camera-card {
      background: rgba(255, 255, 255, 0.03);
      border-radius: 1rem;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: all 0.3s ease;
    }

    .camera-card:hover {
      border-color: rgba(124, 58, 237, 0.5);
      transform: translateY(-4px);
      box-shadow: 0 10px 40px rgba(124, 58, 237, 0.2);
    }

    .camera-card.active {
      border-color: rgba(34, 197, 94, 0.5);
    }

    .camera-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 1rem;
      background: rgba(0, 0, 0, 0.3);
    }

    .camera-label {
      font-weight: 500;
      font-size: 0.9rem;
      color: #e4e4e7;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .camera-meta {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .resolution-badge {
      background: rgba(0, 212, 255, 0.2);
      color: #00d4ff;
      padding: 0.2rem 0.5rem;
      border-radius: 0.5rem;
      font-size: 0.7rem;
      font-weight: 600;
      font-family: monospace;
    }

    .camera-badge {
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      padding: 0.25rem 0.75rem;
      border-radius: 1rem;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.05em;
    }

    .video-container {
      aspect-ratio: 16 / 9;
      background: #0a0a0a;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }

    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .video-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
      color: #52525b;
    }

    .placeholder-icon {
      font-size: 3rem;
    }

    .placeholder-text {
      font-size: 0.9rem;
    }

    .no-cameras {
      grid-column: 1 / -1;
      text-align: center;
      padding: 4rem 2rem;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 1rem;
      border: 2px dashed rgba(255, 255, 255, 0.1);
    }

    .no-cameras-icon {
      font-size: 4rem;
      margin-bottom: 1rem;
    }

    .no-cameras-title {
      font-size: 1.5rem;
      font-weight: 600;
      color: #a1a1aa;
      margin-bottom: 0.5rem;
    }

    .no-cameras-text {
      color: #71717a;
    }

    @media (max-width: 768px) {
      .camera-manager {
        padding: 1rem;
      }

      .title {
        font-size: 1.5rem;
      }

      .controls {
        flex-direction: column;
      }

      .btn {
        justify-content: center;
      }

      .toast-container {
        left: 1rem;
        right: 1rem;
        max-width: none;
      }
    }
  `]
})
export class CameraManagerComponent implements OnInit, OnDestroy {
  @ViewChildren('videoElement') videoElements!: QueryList<ElementRef<HTMLVideoElement>>;
  @ViewChildren('canvasElement') canvasElements!: QueryList<ElementRef<HTMLCanvasElement>>;

  // Signals for reactive state
  readonly cameras = signal<CameraInfo[]>([]);
  readonly isEnumerating = signal(false);
  readonly isFlashing = signal(false);
  readonly capturingCameras = signal<string[]>([]);
  readonly toasts = signal<ToastMessage[]>([]);

  private toastIdCounter = 0;

  // Computed signals
  readonly activeStreams = computed(() =>
    this.cameras().filter(c => c.stream !== null).map(c => c.stream!)
  );

  readonly connectionState = computed(() => this.webRtcService.connectionState());
  readonly isSending = computed(() => this.webRtcService.isSending());
  readonly sendProgress = computed(() => this.webRtcService.sendProgress());

  readonly canCapture = computed(() =>
    this.webRtcService.isConnected() &&
    this.activeStreams().length > 0 &&
    !this.isSending()
  );

  readonly connectionStatusText = computed(() => {
    const state = this.connectionState();
    switch (state) {
      case 'connected': return 'Connected';
      case 'connecting': return 'Connecting...';
      case 'disconnected': return 'Disconnected';
      case 'failed': return 'Connection Failed';
      case 'closed': return 'Connection Closed';
      default: return state;
    }
  });

  constructor(public webRtcService: WebRtcService) { }

  ngOnInit(): void {
    this.enumerateCameras();
  }

  ngOnDestroy(): void {
    this.stopAllCameras();
    this.webRtcService.disconnect();
  }

  // Toast management
  showToast(type: 'success' | 'error' | 'info', title: string, message: string): void {
    const toast: ToastMessage = {
      id: ++this.toastIdCounter,
      type,
      title,
      message
    };
    this.toasts.update(toasts => [...toasts, toast]);

    // Auto-remove after 5 seconds
    setTimeout(() => this.removeToast(toast.id), 5000);
  }

  removeToast(id: number): void {
    this.toasts.update(toasts => toasts.filter(t => t.id !== id));
  }

  async toggleConnection(): Promise<void> {
    if (this.connectionState() === 'connected' || this.connectionState() === 'connecting') {
      this.webRtcService.disconnect();
      this.showToast('info', 'Disconnected', 'WebRTC connection closed');
    } else {
      try {
        await this.webRtcService.connect();
        this.showToast('success', 'Connected!', 'WebRTC Data Channel is ready');
      } catch (error) {
        console.error('Failed to connect:', error);
        this.showToast('error', 'Connection Failed', 'Could not establish WebRTC connection');
      }
    }
  }

  async enumerateCameras(): Promise<void> {
    this.isEnumerating.set(true);

    try {
      // First, request permission to access cameras
      const initialStream = await navigator.mediaDevices.getUserMedia({ video: true });
      // Stop the initial stream immediately - we just needed permission
      initialStream.getTracks().forEach(track => track.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices
        .filter(d => d.kind === 'videoinput')
        .slice(0, 5); // Limit to 5 cameras

      // Stop existing streams
      this.stopAllCameras();

      // Create camera info objects
      const cameraInfos: CameraInfo[] = [];

      for (const device of videoDevices) {
        const cameraInfo: CameraInfo = {
          deviceId: device.deviceId,
          label: device.label || `Camera ${cameraInfos.length + 1}`,
          stream: null
        };

        try {
          // Request maximum resolution - the browser will give us the best it can
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: device.deviceId },
              width: { ideal: 4096, min: 1280 },  // Request up to 4K
              height: { ideal: 2160, min: 720 },
              frameRate: { ideal: 30 }
            }
          });

          cameraInfo.stream = stream;

          // Get actual resolution from the track
          const videoTrack = stream.getVideoTracks()[0];
          const settings = videoTrack.getSettings();
          if (settings.width && settings.height) {
            cameraInfo.resolution = {
              width: settings.width,
              height: settings.height
            };
            console.log(`📷 ${device.label}: ${settings.width}×${settings.height}`);
          }
        } catch (err) {
          console.warn(`Could not access camera ${device.label}:`, err);
        }

        cameraInfos.push(cameraInfo);
      }

      this.cameras.set(cameraInfos);

      // Show toast with camera info
      const activeCameras = cameraInfos.filter(c => c.stream !== null);
      if (activeCameras.length > 0) {
        const resolutions = activeCameras
          .filter(c => c.resolution)
          .map(c => `${c.resolution!.width}×${c.resolution!.height}`)
          .join(', ');
        this.showToast('success', `${activeCameras.length} Camera(s) Ready`, `Resolution: ${resolutions}`);
      }

    } catch (error) {
      console.error('Failed to enumerate cameras:', error);
      this.showToast('error', 'Camera Error', 'Could not access cameras. Check permissions.');
    } finally {
      this.isEnumerating.set(false);
    }
  }

  async captureAndSend(): Promise<void> {
    const images: { cameraId: string; imageData: ArrayBuffer; width: number; height: number }[] = [];
    const camerasList = this.cameras().filter(c => c.stream !== null);

    // Trigger flash effect
    this.isFlashing.set(true);
    setTimeout(() => this.isFlashing.set(false), 300);

    // Mark all cameras as capturing
    this.capturingCameras.set(camerasList.map(c => c.deviceId));

    for (let i = 0; i < camerasList.length; i++) {
      const camera = camerasList[i];
      const videoElement = this.videoElements.find(
        v => v.nativeElement.getAttribute('data-device-id') === camera.deviceId
      );

      if (!videoElement || !camera.stream) continue;

      const video = videoElement.nativeElement;
      const canvas = this.canvasElements.find(
        c => c.nativeElement.getAttribute('data-device-id') === camera.deviceId
      )?.nativeElement;

      if (!canvas) continue;

      // Get the actual video resolution from the track settings
      const videoTrack = camera.stream.getVideoTracks()[0];
      const settings = videoTrack.getSettings();

      // Use actual track resolution, not video element size
      const captureWidth = settings.width || video.videoWidth || 1920;
      const captureHeight = settings.height || video.videoHeight || 1080;

      canvas.width = captureWidth;
      canvas.height = captureHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      // Draw video frame to canvas at full resolution
      ctx.drawImage(video, 0, 0, captureWidth, captureHeight);

      // Convert to JPEG blob with high quality
      const blob = await new Promise<Blob | null>(resolve => {
        canvas.toBlob(resolve, 'image/jpeg', 0.95);
      });

      if (blob) {
        const arrayBuffer = await blob.arrayBuffer();
        images.push({
          cameraId: `cam_${String(i + 1).padStart(2, '0')}`,
          imageData: arrayBuffer,
          width: captureWidth,
          height: captureHeight
        });
        console.log(`📷 Captured camera ${i + 1}: ${captureWidth}×${captureHeight} (${(arrayBuffer.byteLength / 1024).toFixed(1)} KB)`);
      }
    }

    // Clear capturing state after animation
    setTimeout(() => this.capturingCameras.set([]), 500);

    if (images.length === 0) {
      this.showToast('error', 'Capture Failed', 'No images could be captured');
      return;
    }

    // Show capture toast
    const totalSize = images.reduce((sum, img) => sum + img.imageData.byteLength, 0);
    const resolutionInfo = images.map(img => `${img.width}×${img.height}`).join(', ');
    this.showToast('info', `Captured ${images.length} Image(s)`,
      `${resolutionInfo} • ${(totalSize / 1024).toFixed(1)} KB total`);

    console.log(`📸 Sending ${images.length} images over WebRTC Data Channel`);

    try {
      await this.webRtcService.sendImages(images);
      this.showToast('success', 'Transfer Complete!',
        `${images.length} image(s) sent successfully to server`);
    } catch (error) {
      console.error('Send failed:', error);
      this.showToast('error', 'Transfer Failed', 'Could not send images to server');
    }
  }

  private stopAllCameras(): void {
    this.cameras().forEach(camera => {
      if (camera.stream) {
        camera.stream.getTracks().forEach(track => track.stop());
      }
    });
  }
}
