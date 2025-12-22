import { Component, signal, computed, OnInit, OnDestroy, ElementRef, ViewChildren, QueryList } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WebRtcService } from '../services/webrtc.service';

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
    <div class="camera-manager" [class.has-recording-banner]="isRecording()">
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
            <span class="btn-icon">📸</span> Capture All
          }
        </button>

        <button 
          class="btn btn-secondary"
          [disabled]="isEnumerating()"
          (click)="enumerateCameras()">
          <span class="btn-icon">🔄</span> Refresh Cameras
        </button>
      </div>

      <!-- RECORDING ACTIVE BANNER -->
      @if (isRecording()) {
        <div class="recording-banner">
          <div class="recording-banner-content">
            <div class="recording-banner-left">
              <span class="recording-banner-dot"></span>
              <span class="recording-banner-text">RECORDING IN PROGRESS</span>
              <span class="recording-banner-camera">{{ getRecordingCameraLabel() }}</span>
            </div>
            <div class="recording-banner-right">
              <span class="recording-banner-time">{{ recordingDuration() }}</span>
              <button class="recording-banner-stop" (click)="toggleRecording()">
                ⏹ STOP RECORDING
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Recording Controls -->
      <div class="recording-section" [class.recording-active]="isRecording()">
        <h2 class="section-title">🎬 Video Recording</h2>
        <div class="recording-controls">
          <div class="camera-selector">
            <label class="selector-label">Select Camera:</label>
            <select 
              class="camera-select"
              [disabled]="!canRecord() || isRecording()"
              (change)="onCameraSelect($event)">
              <option value="">-- Choose a camera --</option>
              @for (camera of cameras(); track camera.deviceId; let i = $index) {
                @if (camera.stream) {
                  <option [value]="camera.deviceId">
                    {{ camera.label }} ({{ camera.resolution?.width }}×{{ camera.resolution?.height }})
                  </option>
                }
              }
            </select>
          </div>

          @if (!isRecording()) {
            <button 
              class="btn btn-record"
              [disabled]="!canStartRecording()"
              (click)="toggleRecording()">
              <span class="btn-icon">🔴</span> Start Recording
            </button>
          } @else {
            <button 
              class="btn btn-stop-large"
              (click)="toggleRecording()">
              <span class="btn-icon">⏹</span> Stop Recording ({{ recordingDuration() }})
            </button>
          }
        </div>
      </div>

      <!-- Camera info -->
      <div class="camera-info">
        <span class="camera-count">
          {{ activeStreams().length }} camera(s) active
        </span>
        @if (activeStreams().length === 0) {
          <span class="no-cameras-hint">Click "Refresh Cameras" to detect connected webcams</span>
        }
        @if (isRecording()) {
          <span class="recording-indicator">
            <span class="recording-dot-animated"></span>
            Recording from {{ getRecordingCameraLabel() }}
          </span>
        }
      </div>

      <!-- Camera Grid -->
      <div class="camera-grid" [class.cameras-loaded]="activeStreams().length > 0">
        @for (camera of cameras(); track camera.deviceId; let i = $index) {
          <div class="camera-card" 
               [class.active]="camera.stream !== null"
               [class.capturing]="capturingCameras().includes(camera.deviceId)"
               [class.recording]="recordingCameraId() === camera.deviceId">
            <div class="camera-header">
              <span class="camera-label">{{ camera.label || 'Camera ' + i }}</span>
              <div class="camera-meta">
                @if (recordingCameraId() === camera.deviceId) {
                  <span class="recording-badge">
                    <span class="recording-dot-small"></span>
                    REC
                  </span>
                }
                @if (camera.resolution) {
                  <span class="resolution-badge">{{ camera.resolution.width }}×{{ camera.resolution.height }}</span>
                }
                <span class="camera-badge">CAM {{ i + 1 }}</span>
              </div>
            </div>
            <div class="video-container">
              <video 
                #videoElement
                [attr.data-device-id]="camera.deviceId"
                [srcObject]="camera.stream"
                [style.display]="camera.stream ? 'block' : 'none'"
                autoplay 
                playsinline 
                muted>
              </video>
              @if (camera.stream) {
                <div class="camera-flash" [class.active]="capturingCameras().includes(camera.deviceId)"></div>
              }
              @if (!camera.stream) {
                <div class="video-placeholder">
                  <span class="placeholder-icon">📹</span>
                  <span class="placeholder-text">Camera not active</span>
                </div>
              }
              <!-- Recording overlay -->
              @if (recordingCameraId() === camera.deviceId) {
                <div class="recording-overlay">
                  <div class="recording-pulse"></div>
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
  styleUrl: './camera-manager.component.scss'
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
  readonly selectedCameraId = signal<string>('');
  readonly recordingStartTime = signal<number | null>(null);
  readonly recordingDurationMs = signal<number>(0);

  private toastIdCounter = 0;
  private mediaRecorder: MediaRecorder | null = null;
  private recordingTimer: ReturnType<typeof setInterval> | null = null;

  // Computed signals
  readonly activeStreams = computed(() =>
    this.cameras().filter(c => c.stream !== null).map(c => c.stream!)
  );

  readonly connectionState = computed(() => this.webRtcService.connectionState());
  readonly isSending = computed(() => this.webRtcService.isSending());
  readonly sendProgress = computed(() => this.webRtcService.sendProgress());
  readonly isRecording = computed(() => this.webRtcService.isRecording());
  readonly recordingCameraId = computed(() => this.webRtcService.recordingCameraId());

  readonly canCapture = computed(() =>
    this.webRtcService.isConnected() &&
    this.activeStreams().length > 0 &&
    !this.isSending() &&
    !this.isRecording()
  );

  readonly canRecord = computed(() =>
    this.webRtcService.isConnected() &&
    this.activeStreams().length > 0
  );

  readonly canStartRecording = computed(() =>
    this.canRecord() &&
    this.selectedCameraId() !== '' &&
    !this.isRecording()
  );

  readonly recordingDuration = computed(() => {
    const ms = this.recordingDurationMs();
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  });

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
    this.stopRecordingTimer();
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
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
    setTimeout(() => this.removeToast(toast.id), 5000);
  }

  removeToast(id: number): void {
    this.toasts.update(toasts => toasts.filter(t => t.id !== id));
  }

  onCameraSelect(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.selectedCameraId.set(select.value);
  }

  getRecordingCameraLabel(): string {
    const cameraId = this.recordingCameraId();
    const camera = this.cameras().find(c => c.deviceId === cameraId);
    return camera?.label || 'Unknown Camera';
  }

  toggleRecording(): void {
    if (this.isRecording()) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  private startRecording(): void {
    const cameraId = this.selectedCameraId();
    const camera = this.cameras().find(c => c.deviceId === cameraId);

    if (!camera?.stream) {
      this.showToast('error', 'Recording Failed', 'Selected camera is not available');
      return;
    }

    // Determine supported MIME type
    const mimeType = this.getSupportedMimeType();
    if (!mimeType) {
      this.showToast('error', 'Recording Failed', 'No supported video format available');
      return;
    }

    this.mediaRecorder = this.webRtcService.startRecording(cameraId, camera.stream, mimeType);

    if (this.mediaRecorder) {
      this.recordingStartTime.set(Date.now());
      this.startRecordingTimer();
      this.showToast('info', 'Recording Started', `Recording from ${camera.label}`);
    } else {
      this.showToast('error', 'Recording Failed', 'Could not start media recorder');
    }
  }

  private stopRecording(): void {
    console.log('🛑 stopRecording called, mediaRecorder state:', this.mediaRecorder?.state);

    if (this.mediaRecorder) {
      if (this.mediaRecorder.state !== 'inactive') {
        console.log('🛑 Stopping MediaRecorder...');
        this.mediaRecorder.stop();
      } else {
        console.log('⚠️ MediaRecorder already inactive');
        // Manually reset service state if recorder is already stopped
        this.webRtcService.isRecording.set(false);
        this.webRtcService.recordingCameraId.set(null);
      }
    } else {
      console.log('⚠️ No mediaRecorder found');
      // Manually reset service state
      this.webRtcService.isRecording.set(false);
      this.webRtcService.recordingCameraId.set(null);
    }

    this.stopRecordingTimer();
    const duration = this.recordingDuration();
    this.showToast('success', 'Recording Saved', `Video saved (${duration})`);

    this.mediaRecorder = null;
    this.recordingDurationMs.set(0);
    this.recordingStartTime.set(null);
  }

  private startRecordingTimer(): void {
    this.recordingTimer = setInterval(() => {
      const start = this.recordingStartTime();
      if (start) {
        this.recordingDurationMs.set(Date.now() - start);
      }
    }, 100);
  }

  private stopRecordingTimer(): void {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
  }

  private getSupportedMimeType(): string | null {
    const types = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log(`Using MIME type: ${type}`);
        return type;
      }
    }
    return null;
  }

  async toggleConnection(): Promise<void> {
    if (this.connectionState() === 'connected' || this.connectionState() === 'connecting') {
      if (this.isRecording()) {
        this.stopRecording();
      }
      this.webRtcService.disconnect();
      this.showToast('info', 'Disconnected', 'WebRTC connection closed');
    } else {
      try {
        await this.webRtcService.connect();
        this.showToast('success', 'Connected!', 'WebRTC Data Channels ready');
      } catch (error) {
        console.error('Failed to connect:', error);
        this.showToast('error', 'Connection Failed', 'Could not establish WebRTC connection');
      }
    }
  }

  async enumerateCameras(): Promise<void> {
    this.isEnumerating.set(true);

    try {
      const initialStream = await navigator.mediaDevices.getUserMedia({ video: true });
      initialStream.getTracks().forEach(track => track.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices
        .filter(d => d.kind === 'videoinput')
        .slice(0, 5);

      this.stopAllCameras();

      const cameraInfos: CameraInfo[] = [];

      for (const device of videoDevices) {
        const cameraInfo: CameraInfo = {
          deviceId: device.deviceId,
          label: device.label || `Camera ${cameraInfos.length + 1}`,
          stream: null
        };

        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: device.deviceId },
              width: { ideal: 4096, min: 1280 },
              height: { ideal: 2160, min: 720 },
              frameRate: { ideal: 30 }
            }
          });

          cameraInfo.stream = stream;

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

    this.isFlashing.set(true);
    setTimeout(() => this.isFlashing.set(false), 300);

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

      const videoTrack = camera.stream.getVideoTracks()[0];
      const settings = videoTrack.getSettings();

      const captureWidth = settings.width || video.videoWidth || 1920;
      const captureHeight = settings.height || video.videoHeight || 1080;

      canvas.width = captureWidth;
      canvas.height = captureHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      ctx.drawImage(video, 0, 0, captureWidth, captureHeight);

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

    setTimeout(() => this.capturingCameras.set([]), 500);

    if (images.length === 0) {
      this.showToast('error', 'Capture Failed', 'No images could be captured');
      return;
    }

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
