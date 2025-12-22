/**
 * WebRTC connection states
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed' | 'closed';

/**
 * Chunk header structure for images
 */
export interface ChunkHeader {
    CameraId: string;
    ChunkIndex: number;
    TotalChunks: number;
}

/**
 * Video chunk header structure (with chunking support)
 */
export interface VideoChunkHeader {
    Action: 'start' | 'data' | 'stop';
    RecordingId: string;
    CameraId: string;
    MimeType: string;
    ChunkIndex: number;    // Index within this video blob (0-based)
    TotalChunks: number;   // Total chunks for this video blob
    BlobIndex: number;     // Index of the MediaRecorder blob (increments each timeslice)
}

/**
 * Constants for WebRTC data transfer
 */
export const CHUNK_SIZE = 16 * 1024; // 16KB chunks
export const VIDEO_HEADER_SIZE = 256; // Larger header for video metadata (device IDs can be long)
export const IMAGE_HEADER_SIZE = 64; // Header size for images
export const SIGNALING_SERVER_URL = 'ws://localhost:5050/ws';
