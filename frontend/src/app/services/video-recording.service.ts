import { Injectable, signal } from '@angular/core';
import { VideoChunkHeader, CHUNK_SIZE, VIDEO_HEADER_SIZE } from './models';

/**
 * Service for recording and transferring video over WebRTC data channel
 */
@Injectable({ providedIn: 'root' })
export class VideoRecordingService {
    readonly isRecording = signal(false);
    readonly recordingCameraId = signal<string | null>(null);

    private dataChannel: RTCDataChannel | null = null;
    private currentBlobIndex = 0;

    /**
     * Sets the data channel to use for video transfer
     */
    setDataChannel(channel: RTCDataChannel | null): void {
        this.dataChannel = channel;
    }

    /**
     * Starts video recording from the specified camera
     */
    startRecording(cameraId: string, stream: MediaStream, mimeType: string): MediaRecorder | null {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            console.error('❌ Video data channel not available');
            return null;
        }

        const recordingId = crypto.randomUUID();
        this.currentBlobIndex = 0; // Reset blob counter for new recording

        try {
            const mediaRecorder = new MediaRecorder(stream, {
                mimeType,
                videoBitsPerSecond: 2500000 // 2.5 Mbps
            });

            // Send start signal
            this.sendVideoSignal('start', recordingId, cameraId, mimeType);

            mediaRecorder.ondataavailable = async (event) => {
                if (event.data.size > 0) {
                    const arrayBuffer = await event.data.arrayBuffer();
                    console.log(`🎥 Video blob #${this.currentBlobIndex}: ${(arrayBuffer.byteLength / 1024).toFixed(1)} KB`);

                    // Send video data in chunks
                    await this.sendVideoChunked(recordingId, cameraId, mimeType, arrayBuffer, this.currentBlobIndex);
                    this.currentBlobIndex++;
                }
            };

            mediaRecorder.onstart = () => {
                console.log(`🎬 MediaRecorder started for ${cameraId}`);
            };

            mediaRecorder.onstop = () => {
                console.log(`🛑 MediaRecorder stopped for ${cameraId}`);
                // Send stop signal
                this.sendVideoSignal('stop', recordingId, cameraId, mimeType);
                this.isRecording.set(false);
                this.recordingCameraId.set(null);
            };

            mediaRecorder.onerror = (event) => {
                console.error('❌ MediaRecorder error:', event);
                this.isRecording.set(false);
                this.recordingCameraId.set(null);
            };

            // Start recording with 1 second timeslices
            mediaRecorder.start(1000);
            this.isRecording.set(true);
            this.recordingCameraId.set(cameraId);

            console.log(`🎬 Started recording ${recordingId} from ${cameraId}`);
            return mediaRecorder;
        } catch (error) {
            console.error('❌ Failed to start MediaRecorder:', error);
            return null;
        }
    }

    /**
     * Sends video start/stop signal
     */
    private sendVideoSignal(action: 'start' | 'stop', recordingId: string, cameraId: string, mimeType: string): void {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            console.error('❌ Video data channel not available for signal');
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

        // Create padded header packet (no data for start/stop signals)
        const paddedHeader = new Uint8Array(VIDEO_HEADER_SIZE);
        paddedHeader.set(headerBytes.slice(0, VIDEO_HEADER_SIZE));

        this.dataChannel.send(paddedHeader.buffer);
        console.log(`📡 Sent video ${action} signal for ${recordingId}`);
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
        const totalChunks = Math.ceil(data.byteLength / CHUNK_SIZE);

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, data.byteLength);
            const chunkData = data.slice(start, end);

            await this.sendSingleVideoPacket(recordingId, cameraId, mimeType, chunkData, i, totalChunks, blobIndex);
        }
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
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            console.error('❌ Video data channel not available');
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

        // Create padded header
        const paddedHeader = new Uint8Array(VIDEO_HEADER_SIZE);
        paddedHeader.set(headerBytes.slice(0, VIDEO_HEADER_SIZE));

        // Combine header and chunk data
        const packet = new Uint8Array(VIDEO_HEADER_SIZE + chunkData.byteLength);
        packet.set(paddedHeader, 0);
        packet.set(new Uint8Array(chunkData), VIDEO_HEADER_SIZE);

        // Wait for buffer to drain if needed
        await this.waitForBufferDrain();

        this.dataChannel.send(packet.buffer);
    }

    /**
     * Waits for the data channel buffer to drain below threshold
     */
    private waitForBufferDrain(): Promise<void> {
        return new Promise((resolve) => {
            const lowThreshold = 1024 * 1024; // 1MB threshold

            if (!this.dataChannel || this.dataChannel.bufferedAmount < lowThreshold) {
                resolve();
                return;
            }

            const checkBuffer = () => {
                if (!this.dataChannel || this.dataChannel.bufferedAmount < lowThreshold) {
                    resolve();
                } else {
                    setTimeout(checkBuffer, 10);
                }
            };

            checkBuffer();
        });
    }
}
