namespace WebRtcBackend.WebRtc;

/// <summary>
/// Image assembler for reconstructing chunked images from WebRTC data channel
/// </summary>
public class ImageAssembler
{
    private readonly byte[][] _chunks;
    private readonly int _totalChunks;
    private int _receivedCount;

    public ImageAssembler(int totalChunks)
    {
        _totalChunks = totalChunks;
        _chunks = new byte[totalChunks][];
    }

    public bool IsComplete => _receivedCount == _totalChunks;

    public void AddChunk(int index, byte[] data)
    {
        if (index < 0 || index >= _totalChunks) return;

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
