using Microsoft.Playwright;
using System;
using System.Threading;
using System.Threading.Tasks;

namespace CloudPdf.Processor.Services
{
    public class PlaywrightBrowserProvider : IAsyncDisposable
    {
        private IPlaywright? _playwright;
        private IBrowser? _browser;
        private readonly SemaphoreSlim _semaphore = new(1, 1);

        public async Task<IBrowser> GetBrowserAsync()
        {
            if (_browser != null) return _browser;

            await _semaphore.WaitAsync();
            try
            {
                if (_browser == null)
                {
                    Console.WriteLine("[PlaywrightBrowserProvider] Lazily initializing Playwright...");
                    _playwright = await Playwright.CreateAsync();

                    Console.WriteLine("[PlaywrightBrowserProvider] Launching Chromium browser...");
                    _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
                    {
                        Headless = true
                    });
                    Console.WriteLine("[PlaywrightBrowserProvider] Chromium browser launched successfully.");
                }
                return _browser;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[PlaywrightBrowserProvider] ERROR launching browser: {ex.Message}");
                throw;
            }
            finally
            {
                _semaphore.Release();
            }
        }

        public async ValueTask DisposeAsync()
        {
            await _semaphore.WaitAsync();
            try
            {
                if (_browser != null)
                {
                    Console.WriteLine("[PlaywrightBrowserProvider] Disposing Chromium browser...");
                    await _browser.DisposeAsync();
                    _browser = null;
                }

                if (_playwright != null)
                {
                    Console.WriteLine("[PlaywrightBrowserProvider] Disposing Playwright instance...");
                    _playwright.Dispose();
                    _playwright = null;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[PlaywrightBrowserProvider] Error during disposal: {ex.Message}");
            }
            finally
            {
                _semaphore.Release();
                _semaphore.Dispose();
            }
        }
    }
}
