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
  styles: [`
    .camera-manager {
      min-height: 100vh;
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
      color: #e4e4e7;
      padding: 2rem;
      position: relative;
      transition: padding-top 0.3s ease;
    }

    .camera-manager.has-recording-banner {
      padding-top: 5rem;
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

    /* RECORDING BANNER - Very prominent */
    .recording-banner {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: linear-gradient(90deg, #991b1b, #dc2626, #991b1b);
      background-size: 200% 100%;
      animation: bannerPulse 2s ease-in-out infinite;
      padding: 0.75rem 2rem;
      z-index: 999;
      box-shadow: 0 4px 20px rgba(220, 38, 38, 0.5);
    }

    @keyframes bannerPulse {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    .recording-banner-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
      max-width: 1400px;
      margin: 0 auto;
    }

    .recording-banner-left {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .recording-banner-dot {
      width: 16px;
      height: 16px;
      background: white;
      border-radius: 50%;
      animation: dotBlink 0.5s infinite;
    }

    @keyframes dotBlink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.2; }
    }

    .recording-banner-text {
      font-weight: 700;
      font-size: 1.1rem;
      color: white;
      letter-spacing: 0.1em;
    }

    .recording-banner-camera {
      color: rgba(255, 255, 255, 0.8);
      font-size: 0.9rem;
    }

    .recording-banner-right {
      display: flex;
      align-items: center;
      gap: 1.5rem;
    }

    .recording-banner-time {
      font-size: 1.5rem;
      font-weight: 700;
      color: white;
      font-family: monospace;
      background: rgba(0, 0, 0, 0.3);
      padding: 0.25rem 0.75rem;
      border-radius: 0.5rem;
    }

    .recording-banner-stop {
      background: white;
      color: #dc2626;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 0.5rem;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .recording-banner-stop:hover {
      background: #fef2f2;
      transform: scale(1.05);
    }

    .recording-section.recording-active {
      border-color: rgba(220, 38, 38, 0.5);
      box-shadow: 0 0 30px rgba(220, 38, 38, 0.2);
    }

    .btn-stop-large {
      background: linear-gradient(135deg, #dc2626, #b91c1c) !important;
      color: white;
      font-size: 1.1rem !important;
      padding: 1rem 2rem !important;
      animation: stopButtonPulse 1s infinite;
    }

    @keyframes stopButtonPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.7); }
      50% { box-shadow: 0 0 0 10px rgba(220, 38, 38, 0); }
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

    .toast.success { border-left: 4px solid #22c55e; }
    .toast.error { border-left: 4px solid #ef4444; }
    .toast.info { border-left: 4px solid #3b82f6; }

    .toast-icon { font-size: 1.5rem; flex-shrink: 0; }
    .toast-content { flex: 1; }
    .toast-title { font-weight: 600; font-size: 0.95rem; color: #f4f4f5; margin-bottom: 0.25rem; }
    .toast-message { font-size: 0.85rem; color: #a1a1aa; line-height: 1.4; }

    /* Recording Section */
    .recording-section {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 1rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }

    .section-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0 0 1rem 0;
      color: #f4f4f5;
    }

    .recording-controls {
      display: flex;
      gap: 1.5rem;
      align-items: center;
      flex-wrap: wrap;
    }

    .camera-selector {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .selector-label {
      font-size: 0.9rem;
      color: #a1a1aa;
    }

    .camera-select {
      padding: 0.6rem 1rem;
      border-radius: 0.5rem;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.3);
      color: #e4e4e7;
      font-size: 0.9rem;
      min-width: 280px;
      cursor: pointer;
    }

    .camera-select:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .camera-select:focus {
      outline: none;
      border-color: #7c3aed;
    }

    .btn-record {
      background: linear-gradient(135deg, #dc2626, #ef4444);
      color: white;
    }

    .btn-record:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(220, 38, 38, 0.4);
    }

    .btn-stop {
      background: linear-gradient(135deg, #7c3aed, #a855f7);
      color: white;
      animation: recordPulse 1s infinite;
    }

    @keyframes recordPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.5); }
      50% { box-shadow: 0 0 0 10px rgba(220, 38, 38, 0); }
    }

    /* Recording indicators */
    .recording-indicator {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.8rem;
      background: rgba(220, 38, 38, 0.2);
      border: 1px solid rgba(220, 38, 38, 0.5);
      border-radius: 2rem;
      font-size: 0.85rem;
      color: #fca5a5;
    }

    .recording-dot-animated {
      width: 8px;
      height: 8px;
      background: #ef4444;
      border-radius: 50%;
      animation: blink 1s infinite;
    }

    .recording-dot-small {
      width: 6px;
      height: 6px;
      background: #ef4444;
      border-radius: 50%;
      animation: blink 1s infinite;
      display: inline-block;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    .recording-badge {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      background: rgba(220, 38, 38, 0.3);
      color: #fca5a5;
      padding: 0.2rem 0.5rem;
      border-radius: 0.5rem;
      font-size: 0.7rem;
      font-weight: 700;
    }

    .camera-card.recording {
      border-color: rgba(220, 38, 38, 0.7) !important;
      box-shadow: 0 0 30px rgba(220, 38, 38, 0.3);
    }

    .recording-overlay {
      position: absolute;
      top: 0.75rem;
      right: 0.75rem;
      z-index: 15;
    }

    .recording-pulse {
      width: 16px;
      height: 16px;
      background: #ef4444;
      border-radius: 50%;
      animation: recordBlink 1s infinite;
    }

    @keyframes recordBlink {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(1.2); }
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
      0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
      70% { box-shadow: 0 0 0 15px rgba(34, 197, 94, 0); }
      100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
    }

    .header { margin-bottom: 2rem; }

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

    .title-icon { font-size: 2.5rem; }

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

    .connection-status.connected .status-dot { background: #22c55e; }
    .connection-status.connecting .status-dot { background: #f59e0b; }
    .connection-status.failed .status-dot { background: #ef4444; }

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

    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

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

    .btn-icon { font-size: 1.2rem; }
    .spinning { animation: spin 1s linear infinite; }

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

    .camera-count { font-size: 1.1rem; color: #00d4ff; font-weight: 600; }
    .no-cameras-hint { color: #a1a1aa; font-size: 0.9rem; }

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

    .camera-card.active { border-color: rgba(34, 197, 94, 0.5); }

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
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .camera-meta { display: flex; align-items: center; gap: 0.5rem; }

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

    video { width: 100%; height: 100%; object-fit: cover; }

    .video-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
      color: #52525b;
    }

    .placeholder-icon { font-size: 3rem; }
    .placeholder-text { font-size: 0.9rem; }

    .no-cameras {
      grid-column: 1 / -1;
      text-align: center;
      padding: 4rem 2rem;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 1rem;
      border: 2px dashed rgba(255, 255, 255, 0.1);
    }

    .no-cameras-icon { font-size: 4rem; margin-bottom: 1rem; }
    .no-cameras-title { font-size: 1.5rem; font-weight: 600; color: #a1a1aa; margin-bottom: 0.5rem; }
    .no-cameras-text { color: #71717a; }

    @media (max-width: 768px) {
      .camera-manager { padding: 1rem; }
      .title { font-size: 1.5rem; }
      .controls { flex-direction: column; }
      .btn { justify-content: center; }
      .toast-container { left: 1rem; right: 1rem; max-width: none; }
      .recording-controls { flex-direction: column; align-items: stretch; }
      .camera-select { min-width: 100%; }
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
