namespace WebRtcBackend.WebRtc;

/// <summary>
/// Chunk header structure for images
/// </summary>
public record ChunkHeader(string CameraId, int ChunkIndex, int TotalChunks);

/// <summary>
/// Video chunk header structure (with chunking support)
/// </summary>
public record VideoChunkHeader(
    string Action, 
    string RecordingId, 
    string CameraId, 
    string MimeType,
    int ChunkIndex,     // Index within this video blob (0-based)
    int TotalChunks,    // Total chunks for this video blob  
    int BlobIndex       // Index of the MediaRecorder blob (increments each timeslice)
);
