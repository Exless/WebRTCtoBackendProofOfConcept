using WebRtcBackend.WebRtc;

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

// Create signaling handler
var signalingHandler = new SignalingHandler(capturedImagesPath);

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

    await signalingHandler.HandleSignalingAsync(webSocket);
});

app.MapGet("/", () => "WebRTC Multi-Webcam Snapshot & Video Recording Backend is running!");

app.Run("http://localhost:5050");
