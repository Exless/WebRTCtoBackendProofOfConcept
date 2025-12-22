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
- .NET 10 SDK
- Node.js 18+ and npm
- Multiple webcams (or use macOS Continuity Camera with iPhone)

### Running the Application

1. **Start the Backend**:
   ```bash
   cd backend
   dotnet run
   ```
   Backend runs at: http://localhost:5050

2. **Start the Frontend**:
   ```bash
   cd frontend
   npm install
   npm start
   ```
   Frontend runs at: http://localhost:4200

3. **Use the App**:
   - Click **"Refresh Cameras"** to detect webcams
   - Click **"Connect"** to establish WebRTC connection
   - Click **"Capture & Send"** to snapshot all cameras and transfer

4. **View Captured Images**:
   ```bash
   ls backend/CapturedImages/
   ```

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
