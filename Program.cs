using CloudPdf.Processor.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.IO;
using System.Threading.Tasks;

var builder = WebApplication.CreateBuilder(args);

// Register Playwright browser provider as Singleton so it is reused across requests
builder.Services.AddSingleton<PlaywrightBrowserProvider>();
builder.Services.AddTransient<PlaywrightProcessor>();

var app = builder.Build();

// Enable static and default files from wwwroot
app.UseDefaultFiles();
app.UseStaticFiles();

// Main PDF processing streaming endpoint
app.MapPost("/api/process", async (HttpContext context, PlaywrightProcessor processor) =>
{
    // Ensure request is multipart/form-data
    if (!context.Request.HasFormContentType)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsync("Expected multipart/form-data request.");
        return;
    }

    var form = await context.Request.ReadFormAsync();
    var files = form.Files;

    if (files.Count == 0)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsync("No files uploaded.");
        return;
    }

    // Set headers for Server-Sent Events (SSE)
    context.Response.Headers.ContentType = "text/event-stream";
    context.Response.Headers.CacheControl = "no-cache";
    context.Response.Headers.Connection = "keep-alive";

    // Helper method to write standard SSE message chunks
    async Task SendEventAsync(string eventName, object data)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(data);
        await context.Response.WriteAsync($"event: {eventName}\n");
        await context.Response.WriteAsync($"data: {json}\n\n");
        await context.Response.Body.FlushAsync();
    }

    Console.WriteLine($"[API] Batch conversion started for {files.Count} files.");
    await SendEventAsync("start", new { count = files.Count });

    try
    {
        for (int i = 0; i < files.Count; i++)
        {
            var file = files[i];
            Console.WriteLine($"[API] Processing file {i + 1}/{files.Count}: {file.FileName}");

            // Notify client: Start processing (in-memory)
            await SendEventAsync("progress", new { file = file.FileName, index = i, status = "Processing" });

            // Check if file is HTML (quick validation)
            var extension = Path.GetExtension(file.FileName).ToLower();
            if (extension != ".html" && extension != ".htm")
            {
                await SendEventAsync("progress", new { 
                    file = file.FileName, 
                    index = i, 
                    status = "Failed", 
                    error = "Invalid file type. Only .html or .htm files are supported." 
                });
                continue;
            }

            try
            {
                // Read the HTML content directly from the upload stream
                string htmlContent;
                using (var reader = new StreamReader(file.OpenReadStream()))
                {
                    htmlContent = await reader.ReadToEndAsync();
                }

                // Compile HTML to PDF bytes using Playwright
                var pdfBytes = await processor.GeneratePdfFromHtmlAsync(htmlContent);

                // Convert PDF to Base64 to transfer via SSE
                var base64Pdf = Convert.ToBase64String(pdfBytes);

                // Change extension from .html to .pdf
                var pdfName = Path.ChangeExtension(file.FileName, ".pdf");

                // Stream the completed PDF bytes back to the client
                await SendEventAsync("progress", new { 
                    file = file.FileName, 
                    pdfName = pdfName,
                    index = i, 
                    status = "Completed", 
                    pdfBytesBase64 = base64Pdf
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[API] Error rendering PDF for {file.FileName}: {ex.Message}");
                await SendEventAsync("progress", new { 
                    file = file.FileName, 
                    index = i, 
                    status = "Failed", 
                    error = ex.Message 
                });
            }
        }

        Console.WriteLine("[API] Completed batch processing.");
        await SendEventAsync("complete", new { success = true });
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[API] Batch level failure: {ex.Message}");
        await SendEventAsync("error", new { message = ex.Message });
    }
});

app.Run();
