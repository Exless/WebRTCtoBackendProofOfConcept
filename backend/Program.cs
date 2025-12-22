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

Console.WriteLine($"📁 Images will be saved to: {capturedImagesPath}");

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

app.MapGet("/", () => "WebRTC Multi-Webcam Snapshot Backend is running!");

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

    // Chunk reassembler state per camera
    var imageAssemblers = new ConcurrentDictionary<string, ImageAssembler>();

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
                Console.WriteLine("📡 Data channel closed");
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

// Chunk header structure
record ChunkHeader(string CameraId, int ChunkIndex, int TotalChunks);

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
