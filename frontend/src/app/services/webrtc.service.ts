import { Injectable, signal, computed } from '@angular/core';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'closed';

export interface ChunkHeader {
  CameraId: string;
  ChunkIndex: number;
  TotalChunks: number;
}

export interface VideoChunkHeader {
  Action: 'start' | 'data' | 'stop';
  RecordingId: string;
  CameraId: string;
  MimeType: string;
  ChunkIndex: number;    // Index within this video blob (0-based)
  TotalChunks: number;   // Total chunks for this video blob
  BlobIndex: number;     // Index of the MediaRecorder blob (increments each timeslice)
}

const CHUNK_SIZE = 16 * 1024; // 16KB chunks
const VIDEO_HEADER_SIZE = 256; // Larger header for video metadata (device IDs can be long)
const IMAGE_HEADER_SIZE = 64; // Header size for images
const SIGNALING_SERVER_URL = 'ws://localhost:5050/ws';

@Injectable({ providedIn: 'root' })
export class WebRtcService {
  private peerConnection: RTCPeerConnection | null = null;
  private imageDataChannel: RTCDataChannel | null = null;
  private videoDataChannel: RTCDataChannel | null = null;
  private webSocket: WebSocket | null = null;

  // Signal-based reactive state
  readonly connectionState = signal<ConnectionState>('disconnected');
  readonly isConnected = computed(() => this.connectionState() === 'connected');
  readonly isSending = signal<boolean>(false);
  readonly sendProgress = signal<number>(0);
  readonly isRecording = signal<boolean>(false);
  readonly recordingCameraId = signal<string | null>(null);
  readonly isVideoChannelOpen = signal<boolean>(false);

  /**
   * Establishes WebRTC connection to the .NET backend
   */
  async connect(): Promise<void> {
    if (this.connectionState() !== 'disconnected') {
      console.warn('Already connecting or connected');
      return;
    }

    this.connectionState.set('connecting');

    try {
      // Create RTCPeerConnection
      this.peerConnection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      // Create the image data channel
      this.imageDataChannel = this.peerConnection.createDataChannel('image-transfer', {
        ordered: true
      });

      // Create the video data channel
      this.videoDataChannel = this.peerConnection.createDataChannel('video-transfer', {
        ordered: true
      });

      this.setupDataChannelHandlers(this.imageDataChannel, 'image');
      this.setupDataChannelHandlers(this.videoDataChannel, 'video');
      this.setupPeerConnectionHandlers();

      // Connect to signaling server
      await this.connectToSignalingServer();

      // Create and send offer
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      this.sendSignalingMessage({
        type: 'offer',
        sdp: offer.sdp
      });

    } catch (error) {
      console.error('Connection failed:', error);
      this.connectionState.set('failed');
      throw error;
    }
  }

  /**
   * Disconnects and cleans up resources
   */
  disconnect(): void {
    this.imageDataChannel?.close();
    this.videoDataChannel?.close();
    this.peerConnection?.close();
    this.webSocket?.close();

    this.imageDataChannel = null;
    this.videoDataChannel = null;
    this.peerConnection = null;
    this.webSocket = null;

    this.connectionState.set('disconnected');
    this.isRecording.set(false);
    this.recordingCameraId.set(null);
    this.isVideoChannelOpen.set(false);
    console.log('🔌 Disconnected');
  }

  /**
   * Sends multiple images over the data channel with chunking
   * @param images Array of camera ID and image data pairs
   */
  async sendImages(images: { cameraId: string; imageData: ArrayBuffer }[]): Promise<void> {
    if (!this.imageDataChannel || this.imageDataChannel.readyState !== 'open') {
      throw new Error('Image data channel is not open');
    }

    this.isSending.set(true);
    this.sendProgress.set(0);

    let totalImages = images.length;
    let completedImages = 0;

    try {
      for (const { cameraId, imageData } of images) {
        await this.sendChunkedImage(cameraId, imageData);
        completedImages++;
        this.sendProgress.set((completedImages / totalImages) * 100);
      }
      console.log(`✅ Sent all ${totalImages} images`);
    } finally {
      this.isSending.set(false);
    }
  }

  // Blob counter for video recording
  private currentBlobIndex = 0;

  /**
   * Starts video recording from the specified camera
   */
  startRecording(cameraId: string, stream: MediaStream, mimeType: string): MediaRecorder | null {
    console.log(`🎬 startRecording called, channel state: ${this.videoDataChannel?.readyState}, isOpen signal: ${this.isVideoChannelOpen()}`);

    if (!this.videoDataChannel || this.videoDataChannel.readyState !== 'open') {
      console.error(`❌ Video data channel is not open (state: ${this.videoDataChannel?.readyState})`);
      return null;
    }

    if (this.isRecording()) {
      console.warn('Already recording');
      return null;
    }

    const recordingId = `rec_${Date.now()}`;
    this.currentBlobIndex = 0; // Reset blob counter for new recording

    // Send start signal
    this.sendVideoSignal('start', recordingId, cameraId, mimeType);

    // Create MediaRecorder
    console.log(`📹 Creating MediaRecorder with mimeType: ${mimeType}`);
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      videoBitsPerSecond: 5000000 // 5 Mbps for high quality
    });

    mediaRecorder.ondataavailable = async (event) => {
      console.log(`📹 ondataavailable: ${event.data.size} bytes (blob #${this.currentBlobIndex})`);
      if (event.data.size > 0) {
        try {
          const arrayBuffer = await event.data.arrayBuffer();
          await this.sendVideoChunked(recordingId, cameraId, mimeType, arrayBuffer, this.currentBlobIndex);
          this.currentBlobIndex++;
        } catch (err) {
          console.error('❌ Error sending video chunk:', err);
        }
      }
    };

    mediaRecorder.onstart = () => {
      console.log('📹 MediaRecorder started!');
    };

    mediaRecorder.onstop = () => {
      // Send stop signal
      console.log('📹 MediaRecorder onstop event');
      this.sendVideoSignal('stop', recordingId, cameraId, mimeType);
      this.isRecording.set(false);
      this.recordingCameraId.set(null);
      console.log('🛑 Recording stopped');
    };

    mediaRecorder.onerror = (event) => {
      console.error('❌ MediaRecorder error:', event);
      this.isRecording.set(false);
      this.recordingCameraId.set(null);
    };

    // Start recording with timeslice (send data every 1 second)
    console.log('📹 Calling mediaRecorder.start(1000)...');
    mediaRecorder.start(1000);

    this.isRecording.set(true);
    this.recordingCameraId.set(cameraId);
    console.log(`🎬 Started recording from ${cameraId}, state: ${mediaRecorder.state}`);

    return mediaRecorder;
  }

  private sendVideoSignal(action: 'start' | 'stop', recordingId: string, cameraId: string, mimeType: string): void {
    if (!this.videoDataChannel || this.videoDataChannel.readyState !== 'open') {
      console.warn(`⚠️ Video channel not open for ${action} signal (state: ${this.videoDataChannel?.readyState})`);
      return;
    }

    const header: VideoChunkHeader = {
      Action: action,
      RecordingId: recordingId,
      CameraId: cameraId,
      MimeType: mimeType,
      ChunkIndex: 0,
      TotalChunks: 1,
      BlobIndex: 0
    };

    const headerJson = JSON.stringify(header);
    const headerBytes = new TextEncoder().encode(headerJson);

    console.log(`📹 Video signal: ${action}, header size: ${headerBytes.length}/${VIDEO_HEADER_SIZE} bytes`);

    if (headerBytes.length > VIDEO_HEADER_SIZE) {
      console.error(`❌ Video header too large: ${headerBytes.length} > ${VIDEO_HEADER_SIZE}`);
      return;
    }

    // Create padded header buffer
    const packet = new Uint8Array(VIDEO_HEADER_SIZE);
    packet.set(headerBytes);

    try {
      this.videoDataChannel.send(packet.buffer);
      console.log(`✅ Video signal sent: ${action}`);
    } catch (err) {
      console.error(`❌ Failed to send video signal:`, err);
    }
  }

  /**
   * Sends video data in chunks, similar to how images are chunked
   */
  private async sendVideoChunked(
    recordingId: string,
    cameraId: string,
    mimeType: string,
    data: ArrayBuffer,
    blobIndex: number
  ): Promise<void> {
    if (!this.videoDataChannel || this.videoDataChannel.readyState !== 'open') {
      console.warn(`⚠️ Video channel not open (state: ${this.videoDataChannel?.readyState}), skipping blob`);
      return;
    }

    const totalChunks = Math.ceil(data.byteLength / CHUNK_SIZE);
    console.log(`📹 Chunking blob #${blobIndex}: ${data.byteLength} bytes into ${totalChunks} chunks`);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, data.byteLength);
      const chunkData = data.slice(start, end);

      await this.sendSingleVideoPacket(recordingId, cameraId, mimeType, chunkData, i, totalChunks, blobIndex);
    }

    console.log(`✅ Sent all ${totalChunks} chunks for blob #${blobIndex}`);
  }

  /**
   * Sends a single video data packet (one chunk of a blob)
   */
  private async sendSingleVideoPacket(
    recordingId: string,
    cameraId: string,
    mimeType: string,
    chunkData: ArrayBuffer,
    chunkIndex: number,
    totalChunks: number,
    blobIndex: number
  ): Promise<void> {
    if (!this.videoDataChannel || this.videoDataChannel.readyState !== 'open') {
      console.warn(`⚠️ Video channel not open, skipping chunk ${chunkIndex}/${totalChunks}`);
      return;
    }

    const header: VideoChunkHeader = {
      Action: 'data',
      RecordingId: recordingId,
      CameraId: cameraId,
      MimeType: mimeType,
      ChunkIndex: chunkIndex,
      TotalChunks: totalChunks,
      BlobIndex: blobIndex
    };

    const headerJson = JSON.stringify(header);
    const headerBytes = new TextEncoder().encode(headerJson);

    if (headerBytes.length > VIDEO_HEADER_SIZE) {
      console.error(`❌ Video data header too large: ${headerBytes.length} > ${VIDEO_HEADER_SIZE}`);
      return;
    }

    // Create padded header buffer + data
    const packet = new Uint8Array(VIDEO_HEADER_SIZE + chunkData.byteLength);
    packet.set(headerBytes);
    packet.set(new Uint8Array(chunkData), VIDEO_HEADER_SIZE);

    // Wait for buffer to clear if needed
    await this.waitForVideoBufferDrain();

    try {
      this.videoDataChannel.send(packet.buffer);
    } catch (err) {
      console.error(`❌ Failed to send video chunk ${chunkIndex}/${totalChunks}:`, err);
    }
  }

  private async sendChunkedImage(cameraId: string, imageData: ArrayBuffer): Promise<void> {
    const totalChunks = Math.ceil(imageData.byteLength / CHUNK_SIZE);
    console.log(`📤 Sending ${cameraId}: ${imageData.byteLength} bytes in ${totalChunks} chunks`);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, imageData.byteLength);
      const chunkData = imageData.slice(start, end);

      const header: ChunkHeader = {
        CameraId: cameraId,
        ChunkIndex: i,
        TotalChunks: totalChunks
      };

      const packet = this.createImagePacket(header, chunkData);

      // Wait for buffer to clear if needed
      await this.waitForImageBufferDrain();

      this.imageDataChannel!.send(packet);
    }
  }

  private createImagePacket(header: ChunkHeader, chunkData: ArrayBuffer): ArrayBuffer {
    const headerJson = JSON.stringify(header);
    const headerBytes = new TextEncoder().encode(headerJson);

    // Create padded header buffer (64 bytes)
    const headerBuffer = new Uint8Array(IMAGE_HEADER_SIZE);
    headerBuffer.set(headerBytes);

    // Combine header + chunk data
    const packet = new Uint8Array(IMAGE_HEADER_SIZE + chunkData.byteLength);
    packet.set(headerBuffer);
    packet.set(new Uint8Array(chunkData), IMAGE_HEADER_SIZE);

    return packet.buffer;
  }

  private async waitForImageBufferDrain(): Promise<void> {
    const channel = this.imageDataChannel;
    if (!channel) return;

    const MAX_BUFFERED = 256 * 1024; // 256KB
    while (channel.bufferedAmount > MAX_BUFFERED) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  private async waitForVideoBufferDrain(): Promise<void> {
    const channel = this.videoDataChannel;
    if (!channel) return;

    const MAX_BUFFERED = 1024 * 1024; // 1MB for video
    while (channel.bufferedAmount > MAX_BUFFERED) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private setupDataChannelHandlers(channel: RTCDataChannel, type: string): void {
    channel.onopen = () => {
      console.log(`📡 ${type} data channel opened, readyState: ${channel.readyState}`);
      if (type === 'image') {
        this.connectionState.set('connected');
      }
      if (type === 'video') {
        this.isVideoChannelOpen.set(true);
      }
      // Log both channel states
      console.log(`📡 Channel states - image: ${this.imageDataChannel?.readyState}, video: ${this.videoDataChannel?.readyState}`);
    };

    channel.onclose = () => {
      console.log(`📡 ${type} data channel closed`);
      if (type === 'image' && this.connectionState() === 'connected') {
        this.connectionState.set('closed');
      }
      if (type === 'video') {
        this.isVideoChannelOpen.set(false);
      }
    };

    channel.onerror = (error) => {
      console.error(`${type} data channel error:`, error);
      if (type === 'image') {
        this.connectionState.set('failed');
      }
    };

    channel.onmessage = (event) => {
      console.log(`Received ${type} message from server:`, event.data);
    };
  }

  private setupPeerConnectionHandlers(): void {
    if (!this.peerConnection) return;

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignalingMessage({
          type: 'ice-candidate',
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          }
        });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      console.log(`🔗 Peer connection state: ${state}`);

      switch (state) {
        case 'connected':
          break;
        case 'disconnected':
        case 'closed':
          this.connectionState.set('closed');
          break;
        case 'failed':
          this.connectionState.set('failed');
          break;
      }
    };
  }

  private connectToSignalingServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.webSocket = new WebSocket(SIGNALING_SERVER_URL);

      this.webSocket.onopen = () => {
        console.log('🔌 Signaling WebSocket connected');
        resolve();
      };

      this.webSocket.onerror = (error) => {
        console.error('Signaling WebSocket error:', error);
        reject(error);
      };

      this.webSocket.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        await this.handleSignalingMessage(message);
      };

      this.webSocket.onclose = () => {
        console.log('🔌 Signaling WebSocket closed');
      };
    });
  }

  private async handleSignalingMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'answer':
        console.log('📥 Received SDP Answer');
        await this.peerConnection?.setRemoteDescription({
          type: 'answer',
          sdp: message.sdp
        });
        break;

      case 'ice-candidate':
        if (message.candidate) {
          await this.peerConnection?.addIceCandidate(message.candidate);
          console.log('🧊 Added ICE candidate');
        }
        break;

      default:
        console.warn('Unknown signaling message:', message);
    }
  }

  private sendSignalingMessage(message: object): void {
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(message));
    }
  }
}
