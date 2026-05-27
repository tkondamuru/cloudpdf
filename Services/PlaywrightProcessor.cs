using Microsoft.Playwright;
using System;
using System.Threading.Tasks;

namespace CloudPdf.Processor.Services
{
    public class PlaywrightProcessor
    {
        private readonly PlaywrightBrowserProvider _browserProvider;

        public PlaywrightProcessor(PlaywrightBrowserProvider browserProvider)
        {
            _browserProvider = browserProvider;
        }

        public async Task<byte[]> GeneratePdfFromHtmlAsync(string htmlContent)
        {
            Console.WriteLine("[PlaywrightProcessor] Fetching browser instance...");
            var browser = await _browserProvider.GetBrowserAsync();

            Console.WriteLine("[PlaywrightProcessor] Creating isolated browser context & page...");
            await using var context = await browser.NewContextAsync();
            var page = await context.NewPageAsync();

            Console.WriteLine("[PlaywrightProcessor] Loading HTML page content into page DOM...");
            await page.SetContentAsync(htmlContent);

            Console.WriteLine("[PlaywrightProcessor] Compiling PDF via page.PdfAsync...");
            var pdfBytes = await page.PdfAsync(new PagePdfOptions
            {
                Format = "A4",
                PrintBackground = true,
                Margin = new Margin
                {
                    Top = "15mm",
                    Bottom = "15mm",
                    Left = "15mm",
                    Right = "15mm"
                }
            });

            Console.WriteLine("[PlaywrightProcessor] PDF generation complete. Disposing context.");
            return pdfBytes;
        }
    }
}
