import { Injectable, signal } from '@angular/core';
import { ChunkHeader, CHUNK_SIZE, IMAGE_HEADER_SIZE } from './models';

/**
 * Service for transferring images over WebRTC data channel
 */
@Injectable({ providedIn: 'root' })
export class ImageTransferService {
    readonly isSending = signal(false);
    readonly sendProgress = signal(0);

    private dataChannel: RTCDataChannel | null = null;

    /**
     * Sets the data channel to use for image transfer
     */
    setDataChannel(channel: RTCDataChannel | null): void {
        this.dataChannel = channel;
    }

    /**
     * Sends multiple images over the data channel with chunking
     * @param images Array of camera ID and image data pairs
     */
    async sendImages(images: { cameraId: string; imageData: ArrayBuffer }[]): Promise<void> {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('Image data channel not available');
        }

        this.isSending.set(true);
        this.sendProgress.set(0);

        try {
            const totalImages = images.length;

            for (let i = 0; i < totalImages; i++) {
                const { cameraId, imageData } = images[i];
                await this.sendChunkedImage(cameraId, imageData);
                this.sendProgress.set(((i + 1) / totalImages) * 100);
            }

            console.log(`✅ Successfully sent ${totalImages} images`);
        } finally {
            this.isSending.set(false);
        }
    }

    /**
     * Sends a single image in chunks
     */
    private async sendChunkedImage(cameraId: string, imageData: ArrayBuffer): Promise<void> {
        const totalChunks = Math.ceil(imageData.byteLength / CHUNK_SIZE);

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

            // Wait for buffer to drain if needed
            await this.waitForBufferDrain();

            this.dataChannel!.send(packet);
        }
    }

    /**
     * Creates a binary packet with header and chunk data
     */
    private createImagePacket(header: ChunkHeader, chunkData: ArrayBuffer): ArrayBuffer {
        const headerJson = JSON.stringify(header);
        const headerBytes = new TextEncoder().encode(headerJson);

        // Create padded header
        const paddedHeader = new Uint8Array(IMAGE_HEADER_SIZE);
        paddedHeader.set(headerBytes.slice(0, IMAGE_HEADER_SIZE));

        // Combine header and chunk data
        const packet = new Uint8Array(IMAGE_HEADER_SIZE + chunkData.byteLength);
        packet.set(paddedHeader, 0);
        packet.set(new Uint8Array(chunkData), IMAGE_HEADER_SIZE);

        return packet.buffer;
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
