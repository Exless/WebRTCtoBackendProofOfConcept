using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using SIPSorcery.Net;

namespace WebRtcBackend.WebRtc;

/// <summary>
/// Handles WebRTC signaling and data channel message processing
/// </summary>
public class SignalingHandler
{
    private const int ImageHeaderSize = 64;
    private const int VideoHeaderSize = 256;
    
    private readonly string _capturedImagesPath;

    public SignalingHandler(string capturedImagesPath)
    {
        _capturedImagesPath = capturedImagesPath;
    }

    public async Task HandleSignalingAsync(WebSocket webSocket)
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
                    ProcessImageChunk(data, imageAssemblers);
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
                    ProcessVideoChunk(data, videoRecorders);
                };

                channel.onclose += () =>
                {
                    Console.WriteLine("🎥 Video data channel closed");
                    // Finalize any ongoing recordings
                    foreach (var recorder in videoRecorders.Values)
                    {
                        recorder.Finalize(_capturedImagesPath);
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
                _ = SendWebSocketMessageAsync(webSocket, candidateJson);
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

    private static async Task HandleOfferAsync(RTCPeerConnection peerConnection, WebSocket webSocket, JsonElement root)
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

        await SendWebSocketMessageAsync(webSocket, answerJson);
    }

    private static void HandleIceCandidate(RTCPeerConnection peerConnection, JsonElement root)
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

    private static async Task SendWebSocketMessageAsync(WebSocket webSocket, string message)
    {
        if (webSocket.State == WebSocketState.Open)
        {
            var bytes = Encoding.UTF8.GetBytes(message);
            await webSocket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
    }

    private void ProcessImageChunk(byte[] data, ConcurrentDictionary<string, ImageAssembler> assemblers)
    {
        try
        {
            if (data.Length < ImageHeaderSize)
            {
                Console.WriteLine("❌ Received data too small for header");
                return;
            }

            var headerBytes = data[..ImageHeaderSize];
            var headerJson = Encoding.UTF8.GetString(headerBytes).TrimEnd('\0');
            var header = JsonSerializer.Deserialize<ChunkHeader>(headerJson);

            if (header is null)
            {
                Console.WriteLine("❌ Failed to parse chunk header");
                return;
            }

            var chunkData = data[ImageHeaderSize..];

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
                var filePath = Path.Combine(_capturedImagesPath, fileName);

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

    private void ProcessVideoChunk(byte[] data, ConcurrentDictionary<string, VideoRecorder> recorders)
    {
        try
        {
            if (data.Length < VideoHeaderSize)
            {
                Console.WriteLine("❌ Received video data too small for header");
                return;
            }

            var headerBytes = data[..VideoHeaderSize];
            var headerJson = Encoding.UTF8.GetString(headerBytes).TrimEnd('\0');
            var header = JsonSerializer.Deserialize<VideoChunkHeader>(headerJson);

            if (header is null)
            {
                Console.WriteLine("❌ Failed to parse video chunk header");
                return;
            }

            var chunkData = data[VideoHeaderSize..];

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
                        finishedRecorder.Finalize(_capturedImagesPath);
                    }
                    break;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"❌ Error processing video chunk: {ex.Message}");
        }
    }
}
