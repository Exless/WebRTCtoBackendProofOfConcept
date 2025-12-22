import { Injectable, signal, computed, inject } from '@angular/core';
import { ConnectionState, SIGNALING_SERVER_URL } from './models';
import { ImageTransferService } from './image-transfer.service';
import { VideoRecordingService } from './video-recording.service';

/**
 * Core WebRTC service for connection management
 * Delegates image transfer to ImageTransferService
 * Delegates video recording to VideoRecordingService
 */
@Injectable({ providedIn: 'root' })
export class WebRtcService {
  private readonly imageTransferService = inject(ImageTransferService);
  private readonly videoRecordingService = inject(VideoRecordingService);

  private peerConnection: RTCPeerConnection | null = null;
  private imageDataChannel: RTCDataChannel | null = null;
  private videoDataChannel: RTCDataChannel | null = null;
  private webSocket: WebSocket | null = null;

  // Connection state signals
  readonly connectionState = signal<ConnectionState>('disconnected');
  readonly isConnected = computed(() => this.connectionState() === 'connected');

  // Delegate to sub-services
  readonly isSending = this.imageTransferService.isSending;
  readonly sendProgress = this.imageTransferService.sendProgress;
  readonly isRecording = this.videoRecordingService.isRecording;
  readonly recordingCameraId = this.videoRecordingService.recordingCameraId;

  /**
   * Establishes WebRTC connection to the .NET backend
   */
  async connect(): Promise<void> {
    this.connectionState.set('connecting');

    try {
      // Create peer connection
      this.peerConnection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      // Create data channels
      this.imageDataChannel = this.peerConnection.createDataChannel('image-transfer', {
        ordered: true
      });
      this.videoDataChannel = this.peerConnection.createDataChannel('video-transfer', {
        ordered: true
      });

      // Set up handlers
      this.setupDataChannelHandlers(this.imageDataChannel, 'image');
      this.setupDataChannelHandlers(this.videoDataChannel, 'video');
      this.setupPeerConnectionHandlers();

      // Connect to signaling server and exchange SDP
      await this.connectToSignalingServer();

    } catch (error) {
      this.connectionState.set('failed');
      throw error;
    }
  }

  /**
   * Disconnects and cleans up resources
   */
  disconnect(): void {
    if (this.webSocket) {
      this.webSocket.close();
      this.webSocket = null;
    }

    if (this.imageDataChannel) {
      this.imageDataChannel.close();
      this.imageDataChannel = null;
    }

    if (this.videoDataChannel) {
      this.videoDataChannel.close();
      this.videoDataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // Clear sub-service channels
    this.imageTransferService.setDataChannel(null);
    this.videoRecordingService.setDataChannel(null);

    this.connectionState.set('disconnected');
    console.log('🔌 Disconnected');
  }

  /**
   * Sends multiple images over the data channel
   */
  async sendImages(images: { cameraId: string; imageData: ArrayBuffer }[]): Promise<void> {
    return this.imageTransferService.sendImages(images);
  }

  /**
   * Starts video recording from the specified camera
   */
  startRecording(cameraId: string, stream: MediaStream, mimeType: string): MediaRecorder | null {
    return this.videoRecordingService.startRecording(cameraId, stream, mimeType);
  }

  /**
   * Sets up data channel event handlers
   */
  private setupDataChannelHandlers(channel: RTCDataChannel, type: string): void {
    channel.onopen = () => {
      console.log(`📡 ${type} data channel opened`);

      // Pass channel to appropriate service
      if (type === 'image') {
        this.imageTransferService.setDataChannel(channel);
      } else if (type === 'video') {
        this.videoRecordingService.setDataChannel(channel);
      }

      // Check if both channels are open
      if (this.imageDataChannel?.readyState === 'open' &&
        this.videoDataChannel?.readyState === 'open') {
        this.connectionState.set('connected');
      }
    };

    channel.onclose = () => {
      console.log(`📡 ${type} data channel closed`);

      if (type === 'image') {
        this.imageTransferService.setDataChannel(null);
      } else if (type === 'video') {
        this.videoRecordingService.setDataChannel(null);
      }
    };

    channel.onerror = (error) => {
      console.error(`❌ ${type} data channel error:`, error);
    };

    channel.onmessage = (event) => {
      console.log(`📨 Received ${type} message:`, event.data);
    };
  }

  /**
   * Sets up peer connection event handlers
   */
  private setupPeerConnectionHandlers(): void {
    if (!this.peerConnection) return;

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.webSocket?.readyState === WebSocket.OPEN) {
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
      console.log(`🔗 Connection state: ${state}`);

      switch (state) {
        case 'connected':
          // Handled by data channel open
          break;
        case 'disconnected':
        case 'failed':
          this.connectionState.set(state as ConnectionState);
          break;
        case 'closed':
          this.connectionState.set('closed');
          break;
      }
    };
  }

  /**
   * Connects to the signaling server via WebSocket
   */
  private connectToSignalingServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.webSocket = new WebSocket(SIGNALING_SERVER_URL);

      this.webSocket.onopen = async () => {
        console.log('🔌 WebSocket connected');
        await this.createAndSendOffer();
        resolve();
      };

      this.webSocket.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
        reject(error);
      };

      this.webSocket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        this.handleSignalingMessage(message);
      };

      this.webSocket.onclose = () => {
        console.log('🔌 WebSocket closed');
      };
    });
  }

  /**
   * Creates and sends an SDP offer
   */
  private async createAndSendOffer(): Promise<void> {
    if (!this.peerConnection) return;

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    this.sendSignalingMessage({
      type: 'offer',
      sdp: offer.sdp
    });

    console.log('📤 Sent SDP offer');
  }

  /**
   * Handles incoming signaling messages
   */
  private async handleSignalingMessage(message: { type: string; sdp?: string; candidate?: RTCIceCandidateInit }): Promise<void> {
    switch (message.type) {
      case 'answer':
        if (message.sdp) {
          await this.peerConnection?.setRemoteDescription({
            type: 'answer',
            sdp: message.sdp
          });
          console.log('📥 Received SDP answer');
        }
        break;

      case 'ice-candidate':
        if (message.candidate) {
          await this.peerConnection?.addIceCandidate(message.candidate);
          console.log('🧊 Added ICE candidate');
        }
        break;
    }
  }

  /**
   * Sends a message to the signaling server
   */
  private sendSignalingMessage(message: object): void {
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(message));
    }
  }
}
