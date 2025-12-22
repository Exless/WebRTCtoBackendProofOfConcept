using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using SIPSorcery.Net;

var builder = WebApplication.CreateBuilder(args);

// Configure CORS for Angular dev server
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins("http://localhost:4200")
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials();
    });
});

var app = builder.Build();
app.UseCors();

// Ensure CapturedImages directory exists
var capturedImagesPath = Path.Combine(Directory.GetCurrentDirectory(), "CapturedImages");
Directory.CreateDirectory(capturedImagesPath);

Console.WriteLine($"📁 Images/Videos will be saved to: {capturedImagesPath}");

// WebSocket signaling endpoint
app.UseWebSockets();
app.Map("/ws", async context =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = 400;
        await context.Response.WriteAsync("WebSocket connection required");
        return;
    }

    using var webSocket = await context.WebSockets.AcceptWebSocketAsync();
    Console.WriteLine("🔌 WebSocket connected for signaling");

    await HandleSignalingAsync(webSocket, capturedImagesPath);
});

app.MapGet("/", () => "WebRTC Multi-Webcam Snapshot & Video Recording Backend is running!");

app.Run("http://localhost:5050");

static async Task HandleSignalingAsync(WebSocket webSocket, string capturedImagesPath)
{
    // Create SIPSorcery WebRTC peer connection
    var peerConnection = new RTCPeerConnection(new RTCConfiguration
    {
        iceServers =
        [
            new RTCIceServer { urls = "stun:stun.l.google.com:19302" }
        ]
    });

    // Chunk reassembler state per camera (for images)
    var imageAssemblers = new ConcurrentDictionary<string, ImageAssembler>();
    
    // Video recording state
    var videoRecorders = new ConcurrentDictionary<string, VideoRecorder>();

    // Handle Data Channel
    peerConnection.ondatachannel += (channel) =>
    {
        Console.WriteLine($"📡 Data channel opened: {channel.label}");

        if (channel.label == "image-transfer")
        {
            channel.onmessage += (_, _, data) =>
            {
                ProcessIncomingChunk(data, imageAssemblers, capturedImagesPath);
            };

            channel.onclose += () =>
            {
                Console.WriteLine("📡 Image data channel closed");
            };
        }
        else if (channel.label == "video-transfer")
        {
            channel.onmessage += (_, _, data) =>
            {
                ProcessVideoChunk(data, videoRecorders, capturedImagesPath);
            };

            channel.onclose += () =>
            {
                Console.WriteLine("🎥 Video data channel closed");
                // Finalize any ongoing recordings
                foreach (var recorder in videoRecorders.Values)
                {
                    recorder.Finalize(capturedImagesPath);
                }
                videoRecorders.Clear();
            };
        }
    };

    // Handle ICE candidates
    peerConnection.onicecandidate += (candidate) =>
    {
        if (candidate is not null)
        {
            var candidateJson = JsonSerializer.Serialize(new
            {
                type = "ice-candidate",
                candidate = new
                {
                    candidate = candidate.candidate,
                    sdpMid = candidate.sdpMid,
                    sdpMLineIndex = candidate.sdpMLineIndex
                }
            });
            _ = SendWebSocketMessage(webSocket, candidateJson);
        }
    };

    peerConnection.onconnectionstatechange += (state) =>
    {
        Console.WriteLine($"🔗 Connection state: {state}");
    };

    // Message handling loop
    var buffer = new byte[8192];
    try
    {
        while (webSocket.State == WebSocketState.Open)
        {
            var result = await webSocket.ReceiveAsync(buffer, CancellationToken.None);

            if (result.MessageType == WebSocketMessageType.Close)
            {
                await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closed", CancellationToken.None);
                break;
            }

            var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
            var json = JsonDocument.Parse(message);
            var messageType = json.RootElement.GetProperty("type").GetString();

            switch (messageType)
            {
                case "offer":
                    await HandleOfferAsync(peerConnection, webSocket, json.RootElement);
                    break;

                case "ice-candidate":
                    HandleIceCandidate(peerConnection, json.RootElement);
                    break;

                default:
                    Console.WriteLine($"Unknown message type: {messageType}");
                    break;
            }
        }
    }
    catch (WebSocketException ex)
    {
        Console.WriteLine($"WebSocket error: {ex.Message}");
    }
    finally
    {
        peerConnection.close();
        Console.WriteLine("🔌 Peer connection closed");
    }
}

static async Task HandleOfferAsync(RTCPeerConnection peerConnection, WebSocket webSocket, JsonElement root)
{
    var sdp = root.GetProperty("sdp").GetString()!;
    Console.WriteLine("📥 Received SDP Offer");

    // Set remote description (the offer from the browser)
    var offerSdp = new RTCSessionDescriptionInit
    {
        type = RTCSdpType.offer,
        sdp = sdp
    };

    var setResult = peerConnection.setRemoteDescription(offerSdp);
    if (setResult != SetDescriptionResultEnum.OK)
    {
        Console.WriteLine($"❌ Failed to set remote description: {setResult}");
        return;
    }

    // Create and set local description (the answer)
    var answer = peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    Console.WriteLine("📤 Sending SDP Answer");

    var answerJson = JsonSerializer.Serialize(new
    {
        type = "answer",
        sdp = answer.sdp
    });

    await SendWebSocketMessage(webSocket, answerJson);
}

static void HandleIceCandidate(RTCPeerConnection peerConnection, JsonElement root)
{
    if (root.TryGetProperty("candidate", out var candidateElement))
    {
        var candidateStr = candidateElement.GetProperty("candidate").GetString();
        var sdpMid = candidateElement.GetProperty("sdpMid").GetString();
        var sdpMLineIndex = candidateElement.GetProperty("sdpMLineIndex").GetUInt16();

        if (!string.IsNullOrEmpty(candidateStr))
        {
            var iceCandidate = new RTCIceCandidateInit
            {
                candidate = candidateStr,
                sdpMid = sdpMid,
                sdpMLineIndex = sdpMLineIndex
            };

            peerConnection.addIceCandidate(iceCandidate);
            Console.WriteLine("🧊 Added ICE candidate");
        }
    }
}

static async Task SendWebSocketMessage(WebSocket webSocket, string message)
{
    if (webSocket.State == WebSocketState.Open)
    {
        var bytes = Encoding.UTF8.GetBytes(message);
        await webSocket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
    }
}

static void ProcessIncomingChunk(byte[] data, ConcurrentDictionary<string, ImageAssembler> assemblers, string capturedImagesPath)
{
    try
    {
        // Protocol: First 64 bytes = header (JSON padded with null bytes)
        // Remaining bytes = chunk data
        const int HeaderSize = 64;

        if (data.Length < HeaderSize)
        {
            Console.WriteLine("❌ Received data too small for header");
            return;
        }

        var headerBytes = data[..HeaderSize];
        var headerJson = Encoding.UTF8.GetString(headerBytes).TrimEnd('\0');
        var header = JsonSerializer.Deserialize<ChunkHeader>(headerJson);

        if (header is null)
        {
            Console.WriteLine("❌ Failed to parse chunk header");
            return;
        }

        var chunkData = data[HeaderSize..];

        var assembler = assemblers.GetOrAdd(header.CameraId, _ => new ImageAssembler(header.TotalChunks));

        // Reset if starting a new transfer for this camera (marked by chunk 0)
        if (header.ChunkIndex == 0)
        {
            assemblers[header.CameraId] = new ImageAssembler(header.TotalChunks);
            assembler = assemblers[header.CameraId];
            Console.WriteLine($"📷 Starting image transfer for camera: {header.CameraId}");
        }

        assembler.AddChunk(header.ChunkIndex, chunkData);

        if (assembler.IsComplete)
        {
            var imageData = assembler.GetCompleteImage();
            var timestamp = DateTime.UtcNow.ToString("yyyyMMdd_HHmmss_fff");
            var fileName = $"{header.CameraId}_{timestamp}.jpg";
            var filePath = Path.Combine(capturedImagesPath, fileName);

            File.WriteAllBytes(filePath, imageData);
            Console.WriteLine($"✅ Saved image: {fileName} ({imageData.Length:N0} bytes)");

            // Clean up
            assemblers.TryRemove(header.CameraId, out _);
        }
        else
        {
            Console.WriteLine($"📦 Received chunk {header.ChunkIndex + 1}/{header.TotalChunks} for {header.CameraId}");
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"❌ Error processing chunk: {ex.Message}");
    }
}

static void ProcessVideoChunk(byte[] data, ConcurrentDictionary<string, VideoRecorder> recorders, string capturedImagesPath)
{
    try
    {
        // Protocol: First 256 bytes = header (JSON padded with null bytes)
        // Remaining bytes = video chunk data
        const int HeaderSize = 256;

        if (data.Length < HeaderSize)
        {
            Console.WriteLine("❌ Received video data too small for header");
            return;
        }

        var headerBytes = data[..HeaderSize];
        var headerJson = Encoding.UTF8.GetString(headerBytes).TrimEnd('\0');
        var header = JsonSerializer.Deserialize<VideoChunkHeader>(headerJson);

        if (header is null)
        {
            Console.WriteLine("❌ Failed to parse video chunk header");
            return;
        }

        var chunkData = data[HeaderSize..];

        switch (header.Action)
        {
            case "start":
                var recorder = new VideoRecorder(header.RecordingId, header.CameraId, header.MimeType);
                recorders[header.RecordingId] = recorder;
                Console.WriteLine($"🎬 Started recording: {header.RecordingId} from {header.CameraId}");
                break;

            case "data":
                if (recorders.TryGetValue(header.RecordingId, out var activeRecorder))
                {
                    activeRecorder.AddChunk(header.BlobIndex, header.ChunkIndex, header.TotalChunks, chunkData);
                    Console.WriteLine($"🎥 Received chunk {header.ChunkIndex + 1}/{header.TotalChunks} for blob #{header.BlobIndex} ({chunkData.Length:N0} bytes)");
                }
                break;

            case "stop":
                if (recorders.TryRemove(header.RecordingId, out var finishedRecorder))
                {
                    finishedRecorder.Finalize(capturedImagesPath);
                }
                break;
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"❌ Error processing video chunk: {ex.Message}");
    }
}

// Chunk header structure for images
record ChunkHeader(string CameraId, int ChunkIndex, int TotalChunks);

// Video chunk header structure (with chunking support)
record VideoChunkHeader(
    string Action, 
    string RecordingId, 
    string CameraId, 
    string MimeType,
    int ChunkIndex,     // Index within this video blob (0-based)
    int TotalChunks,    // Total chunks for this video blob  
    int BlobIndex       // Index of the MediaRecorder blob (increments each timeslice)
);

// Image assembler for reconstructing chunked images
class ImageAssembler(int totalChunks)
{
    private readonly byte[][] _chunks = new byte[totalChunks][];
    private int _receivedCount;

    public bool IsComplete => _receivedCount == totalChunks;

    public void AddChunk(int index, byte[] data)
    {
        if (index < 0 || index >= totalChunks) return;

        if (_chunks[index] is null)
        {
            _chunks[index] = data;
            _receivedCount++;
        }
    }

    public byte[] GetCompleteImage()
    {
        var totalSize = _chunks.Sum(c => c?.Length ?? 0);
        var result = new byte[totalSize];
        var offset = 0;

        foreach (var chunk in _chunks)
        {
            if (chunk is not null)
            {
                Buffer.BlockCopy(chunk, 0, result, offset, chunk.Length);
                offset += chunk.Length;
            }
        }

        return result;
    }
}

// Video recorder for accumulating video blobs (each blob is reassembled from chunks)
class VideoRecorder
{
    // Store complete blobs in order (key = blobIndex, value = blob data)
    private readonly SortedDictionary<int, byte[]> _blobs = new();
    // Temporary storage for blob chunks being reassembled (key = blobIndex)
    private readonly ConcurrentDictionary<int, BlobAssembler> _blobAssemblers = new();
    
    private readonly string _recordingId;
    private readonly string _cameraId;
    private readonly string _mimeType;

    public long TotalBytes { get; private set; }
    public int BlobCount => _blobs.Count;

    public VideoRecorder(string recordingId, string cameraId, string mimeType)
    {
        _recordingId = recordingId;
        _cameraId = cameraId;
        _mimeType = mimeType;
    }

    public void AddChunk(int blobIndex, int chunkIndex, int totalChunks, byte[] chunkData)
    {
        // Get or create assembler for this blob
        var assembler = _blobAssemblers.GetOrAdd(blobIndex, _ => new BlobAssembler(totalChunks));
        
        assembler.AddChunk(chunkIndex, chunkData);
        
        // Check if blob is complete
        if (assembler.IsComplete)
        {
            var blobData = assembler.GetCompleteBlob();
            _blobs[blobIndex] = blobData;
            TotalBytes += blobData.Length;
            _blobAssemblers.TryRemove(blobIndex, out _);
            Console.WriteLine($"📦 Blob #{blobIndex} complete: {blobData.Length:N0} bytes");
        }
    }

    public void Finalize(string outputDirectory)
    {
        if (_blobs.Count == 0)
        {
            Console.WriteLine($"⚠️ No video data to save for {_recordingId}");
            return;
        }

        // Determine file extension based on mime type
        var extension = _mimeType switch
        {
            string m when m.Contains("webm") => ".webm",
            string m when m.Contains("mp4") => ".mp4",
            string m when m.Contains("ogg") => ".ogg",
            _ => ".webm"
        };

        var timestamp = DateTime.UtcNow.ToString("yyyyMMdd_HHmmss");
        var fileName = $"video_{_cameraId}_{timestamp}{extension}";
        var filePath = Path.Combine(outputDirectory, fileName);

        // Combine all blobs in order into final video file
        using var fileStream = new FileStream(filePath, FileMode.Create, FileAccess.Write);
        foreach (var kvp in _blobs)
        {
            fileStream.Write(kvp.Value, 0, kvp.Value.Length);
        }

        Console.WriteLine($"✅ Saved video: {fileName} ({TotalBytes:N0} bytes, {_blobs.Count} blobs)");
    }
}

// Blob assembler for reconstructing a single MediaRecorder blob from chunks
class BlobAssembler(int totalChunks)
{
    private readonly byte[][] _chunks = new byte[totalChunks][];
    private int _receivedCount;

    public bool IsComplete => _receivedCount == totalChunks;

    public void AddChunk(int index, byte[] data)
    {
        if (index < 0 || index >= totalChunks) return;

        if (_chunks[index] is null)
        {
            _chunks[index] = data;
            _receivedCount++;
        }
    }

    public byte[] GetCompleteBlob()
    {
        var totalSize = _chunks.Sum(c => c?.Length ?? 0);
        var result = new byte[totalSize];
        var offset = 0;

        foreach (var chunk in _chunks)
        {
            if (chunk is not null)
            {
                Buffer.BlockCopy(chunk, 0, result, offset, chunk.Length);
                offset += chunk.Length;
            }
        }

        return result;
    }
}
