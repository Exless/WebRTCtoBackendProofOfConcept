# WebRTC Multi-Webcam Snapshot PoC

A cutting-edge Proof of Concept for capturing high-quality snapshots from multiple webcams simultaneously and transferring them via WebRTC Data Channel.

## 🎯 Features

- **Multi-Camera Support**: Detect and capture from up to 5 webcams simultaneously
- **High Resolution**: Requests up to 4K resolution from cameras (actual resolution depends on camera capabilities)
- **WebRTC Data Channel**: Images transferred over peer-to-peer WebRTC connection (not HTTP)
- **Chunked Transfer**: Robust 16KB chunking strategy prevents Data Channel buffer overflow
- **Modern Stack**: Angular v20 with Signals + .NET 10 Minimal API with SIPSorcery

## 🏗️ Architecture

### Backend (.NET 10 Minimal API)
- **WebRTC Peer**: Uses SIPSorcery library as passive peer
- **WebSocket Signaling**: SDP Offer/Answer exchange at `/ws`
- **Data Channel**: Listens for `image-transfer` channel
- **Chunk Reassembly**: Reconstructs images from 16KB chunks with JSON headers
- **Auto-Save**: Saves completed images as `.jpg` files with timestamps

### Frontend (Angular v20)
- **Standalone Components**: No NgModules, modern architecture
- **Signal-based Reactivity**: Uses `signal()` and `computed()` for state management
- **Multi-Camera Detection**: `navigator.mediaDevices.enumerateDevices()`
- **Live Previews**: Real-time video feeds from all cameras
- **Visual Feedback**: Flash effects, toast notifications, capture animations

## 🚀 Getting Started

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| .NET SDK | 10+ | [Download](https://dotnet.microsoft.com/download) |
| Node.js | 18+ | [Download](https://nodejs.org/) |
| npm | 9+ | Comes with Node.js |
| FFmpeg | Any | Required for video recording MP4 conversion |

**Optional**: Multiple webcams or use macOS Continuity Camera with iPhone

### Quick Start

```bash
# Terminal 1 - Backend
cd backend
dotnet run
# → http://localhost:5050

# Terminal 2 - Frontend
cd frontend
npm install
npm start
# → http://localhost:4200
```

### Step-by-Step Instructions

1. **Clone and Install**:
   ```bash
   git clone <repo-url>
   cd WebRTCDemo
   
   # Install frontend dependencies
   cd frontend && npm install
   ```

2. **Start the Backend** (Terminal 1):
   ```bash
   cd backend
   dotnet run
   ```
   You should see: `Now listening on: http://localhost:5050`

3. **Start the Frontend** (Terminal 2):
   ```bash
   cd frontend
   npm start
   ```
   You should see: `Local: http://localhost:4200/`

4. **Open the App**:
   - Navigate to http://localhost:4200 in your browser
   - Allow camera permissions when prompted

5. **Use the App**:
   - Click **"Refresh Cameras"** to detect webcams
   - Click **"Connect"** to establish WebRTC connection
   - Click **"Capture & Send"** to snapshot all cameras
   - Click **"Start Recording"** to record video from all cameras

6. **View Captured Media**:
   ```bash
   ls backend/CapturedImages/
   # Images: cam_01_20231223_120000.jpg
   # Videos: rec_abc123_cam_01_20231223_120000.mp4
   ```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Port 5050 in use | `lsof -ti:5050 \| xargs kill -9` |
| Port 4200 in use | `lsof -ti:4200 \| xargs kill -9` |
| No cameras detected | Check browser permissions, try refreshing |
| Video not converting to MP4 | Install FFmpeg: `brew install ffmpeg` (macOS) |

## 📸 How It Works

1. **Camera Enumeration**: Frontend requests camera permissions and enumerates video devices
2. **WebRTC Setup**: Frontend creates RTCPeerConnection and Data Channel, sends SDP Offer via WebSocket
3. **Signaling**: Backend receives Offer, creates Answer, exchanges ICE candidates
4. **Capture**: User clicks button → frontend captures snapshots from all video feeds to canvas
5. **Chunking**: Each image is split into 16KB chunks with 64-byte JSON headers (CameraId, ChunkIndex, TotalChunks)
6. **Transfer**: Chunks sent sequentially over Data Channel with backpressure handling
7. **Reassembly**: Backend reconstructs images and saves as `cam_01_timestamp.jpg`

## 🛠️ Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend Framework | Angular v20 (Standalone) |
| Frontend State | Signals API |
| Backend Framework | .NET 10 Minimal API |
| WebRTC Library | SIPSorcery 8.0.23 |
| Signaling | WebSocket |
| Data Transfer | RTCDataChannel |
| Image Format | JPEG (95% quality) |

## 📁 Project Structure

```
WebRTCDemo/
├── backend/
│   ├── Program.cs              # WebRTC + WebSocket server
│   ├── CapturedImages/         # Output directory for JPGs
│   └── WebRtcBackend.csproj
└── frontend/
    └── src/app/
        ├── app.ts              # Root component
        ├── services/
        │   └── webrtc.service.ts    # WebRTC connection manager
        └── components/
            └── camera-manager.component.ts  # Multi-camera UI
```

## 🎨 UI Features

- **Dark Theme**: Premium gradient design with glassmorphism
- **Resolution Badges**: Shows actual camera resolution (e.g., `1920×1080`)
- **Toast Notifications**: Success/error feedback with auto-dismiss
- **Flash Effects**: Visual feedback when capturing
- **Progress Indicators**: Real-time transfer progress
- **Responsive Layout**: Adapts to different screen sizes

## 🔧 Configuration

### Camera Resolution
Edit `frontend/src/app/components/camera-manager.component.ts`:
```typescript
width: { ideal: 4096, min: 1280 },  // Request up to 4K
height: { ideal: 2160, min: 720 },
```

### Chunk Size
Edit `frontend/src/app/services/webrtc.service.ts`:
```typescript
const CHUNK_SIZE = 16 * 1024; // 16KB chunks
```

### JPEG Quality
Edit `frontend/src/app/components/camera-manager.component.ts`:
```typescript
canvas.toBlob(resolve, 'image/jpeg', 0.95); // 95% quality
```

## 📝 License

MIT

## 🙏 Acknowledgments

- [SIPSorcery](https://github.com/sipsorcery-org/sipsorcery) - WebRTC library for .NET
- [Angular](https://angular.dev) - Modern web framework
