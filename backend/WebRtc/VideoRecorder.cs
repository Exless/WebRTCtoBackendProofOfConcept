using System.Collections.Concurrent;
using System.Diagnostics;

namespace WebRtcBackend.WebRtc;

/// <summary>
/// Video recorder for accumulating video blobs (each blob is reassembled from chunks)
/// </summary>
public class VideoRecorder
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
        var baseFileName = $"video_{_cameraId[..8]}_{timestamp}"; // Use first 8 chars of camera ID
        var rawFilePath = Path.Combine(outputDirectory, $"{baseFileName}{extension}");

        // Combine all blobs in order into final video file
        using (var fileStream = new FileStream(rawFilePath, FileMode.Create, FileAccess.Write))
        {
            foreach (var kvp in _blobs)
            {
                fileStream.Write(kvp.Value, 0, kvp.Value.Length);
            }
        }

        Console.WriteLine($"💾 Saved raw video: {Path.GetFileName(rawFilePath)} ({TotalBytes:N0} bytes, {_blobs.Count} blobs)");

        // Convert to MP4 if the source is WebM
        if (extension == ".webm")
        {
            var mp4FilePath = Path.Combine(outputDirectory, $"{baseFileName}.mp4");
            ConvertToMp4(rawFilePath, mp4FilePath);
        }
    }

    private static void ConvertToMp4(string inputPath, string outputPath)
    {
        try
        {
            Console.WriteLine($"🔄 Converting to MP4...");
            
            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "ffmpeg",
                    Arguments = $"-i \"{inputPath}\" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -y \"{outputPath}\"",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };

            process.Start();
            var stderr = process.StandardError.ReadToEnd(); // FFmpeg outputs to stderr
            process.WaitForExit();

            if (process.ExitCode == 0)
            {
                var mp4Size = new FileInfo(outputPath).Length;
                Console.WriteLine($"✅ Converted to MP4: {Path.GetFileName(outputPath)} ({mp4Size:N0} bytes)");
                
                // Delete the original WebM file
                File.Delete(inputPath);
                Console.WriteLine($"🗑️ Deleted original WebM file");
            }
            else
            {
                Console.WriteLine($"❌ FFmpeg conversion failed (exit code {process.ExitCode})");
                Console.WriteLine($"   Error: {stderr}");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"❌ Error converting to MP4: {ex.Message}");
            Console.WriteLine($"   Make sure FFmpeg is installed and in your PATH");
        }
    }
}
