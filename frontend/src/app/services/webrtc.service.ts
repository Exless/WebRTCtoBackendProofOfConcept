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

const CHUNK_SIZE = 16 * 1024; // 16KB chunks
const HEADER_SIZE = 64; // Fixed header size in bytes
const SIGNALING_SERVER_URL = 'ws://localhost:5050/ws';

@Injectable({ providedIn: 'root' })
export class WebRtcService {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private webSocket: WebSocket | null = null;

  // Signal-based reactive state
  readonly connectionState = signal<ConnectionState>('disconnected');
  readonly isConnected = computed(() => this.connectionState() === 'connected');
  readonly isSending = signal<boolean>(false);
  readonly sendProgress = signal<number>(0);

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

      // Create the data channel BEFORE creating the offer
      this.dataChannel = this.peerConnection.createDataChannel('image-transfer', {
        ordered: true
      });

      this.setupDataChannelHandlers();
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
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.webSocket?.close();

    this.dataChannel = null;
    this.peerConnection = null;
    this.webSocket = null;

    this.connectionState.set('disconnected');
    console.log('🔌 Disconnected');
  }

  /**
   * Sends multiple images over the data channel with chunking
   * @param images Array of camera ID and image data pairs
   */
  async sendImages(images: { cameraId: string; imageData: ArrayBuffer }[]): Promise<void> {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Data channel is not open');
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

      const packet = this.createPacket(header, chunkData);

      // Wait for buffer to clear if needed
      await this.waitForBufferDrain();

      this.dataChannel!.send(packet);
    }
  }

  private createPacket(header: ChunkHeader, chunkData: ArrayBuffer): ArrayBuffer {
    const headerJson = JSON.stringify(header);
    const headerBytes = new TextEncoder().encode(headerJson);

    // Create padded header buffer (64 bytes)
    const headerBuffer = new Uint8Array(HEADER_SIZE);
    headerBuffer.set(headerBytes);

    // Combine header + chunk data
    const packet = new Uint8Array(HEADER_SIZE + chunkData.byteLength);
    packet.set(headerBuffer);
    packet.set(new Uint8Array(chunkData), HEADER_SIZE);

    return packet.buffer;
  }

  private async waitForBufferDrain(): Promise<void> {
    const channel = this.dataChannel;
    if (!channel) return;

    // Wait if buffer is getting full (backpressure)
    const MAX_BUFFERED = 256 * 1024; // 256KB
    while (channel.bufferedAmount > MAX_BUFFERED) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  private setupDataChannelHandlers(): void {
    if (!this.dataChannel) return;

    this.dataChannel.onopen = () => {
      console.log('📡 Data channel opened');
      this.connectionState.set('connected');
    };

    this.dataChannel.onclose = () => {
      console.log('📡 Data channel closed');
      if (this.connectionState() === 'connected') {
        this.connectionState.set('closed');
      }
    };

    this.dataChannel.onerror = (error) => {
      console.error('Data channel error:', error);
      this.connectionState.set('failed');
    };

    this.dataChannel.onmessage = (event) => {
      console.log('Received message from server:', event.data);
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
          // Connection state is set when data channel opens
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
