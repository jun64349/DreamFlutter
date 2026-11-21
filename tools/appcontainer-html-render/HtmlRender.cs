using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class HtmlRender
{
    private const int MaxEdge = 8192;
    private const int MaxPixels = 12000000;
    private const int MaxDocument = 16 * 1024 * 1024;
    private const int MaxPng = 8 * 1024 * 1024;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 0) throw new InvalidDataException("Unexpected command arguments");
            using (var input = new BinaryReader(Console.OpenStandardInput()))
            {
                // The caller sends a fixed little-endian header and the sanitized UTF-8 document.
                int width = input.ReadInt32();
                int height = input.ReadInt32();
                int waitMs = input.ReadInt32();
                int fullPage = input.ReadInt32();
                int length = input.ReadInt32();
                if (width < 1 || width > MaxEdge || height < 1 || height > MaxEdge ||
                    width * height > MaxPixels || waitMs < 0 || waitMs > 14999 ||
                    fullPage < 0 || fullPage > 1 || length < 1 || length > MaxDocument)
                    throw new InvalidDataException("Invalid render request");
                byte[] bytes = input.ReadBytes(length);
                if (bytes.Length != length) throw new EndOfStreamException();
                Capture(new UTF8Encoding(false, true).GetString(bytes), width, height, waitMs, fullPage == 1);
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    private static void Capture(string html, int width, int height, int waitMs, bool fullPage)
    {
        using (var form = new Form { ShowInTaskbar = false, ClientSize = new Size(width, height), BackColor = Color.White })
        using (var browser = new WebBrowser
        {
            AllowWebBrowserDrop = false,
            IsWebBrowserContextMenuEnabled = false,
            WebBrowserShortcutsEnabled = false,
            ScriptErrorsSuppressed = true,
            Dock = DockStyle.Fill
        })
        {
            browser.Navigating += delegate(object sender, WebBrowserNavigatingEventArgs e)
            {
                if (e.Url.AbsoluteUri != "about:blank") e.Cancel = true;
            };
            browser.NewWindow += delegate(object sender, System.ComponentModel.CancelEventArgs e) { e.Cancel = true; };
            form.Controls.Add(browser);
            // Create the ActiveX window handles without showing a window.
            form.CreateControl();
            if (form.Handle == IntPtr.Zero || browser.Handle == IntPtr.Zero)
                throw new InvalidOperationException("Could not create the off-screen control");
            browser.DocumentText = html;
            var clock = Stopwatch.StartNew();
            while (browser.ReadyState != WebBrowserReadyState.Complete && clock.ElapsedMilliseconds < 13000)
            {
                Application.DoEvents();
                Thread.Sleep(20);
            }
            if (browser.ReadyState != WebBrowserReadyState.Complete) throw new TimeoutException("HTML document did not load");
            clock.Restart();
            while (clock.ElapsedMilliseconds < waitMs)
            {
                Application.DoEvents();
                Thread.Sleep(20);
            }

            bool cropped = false;
            if (fullPage && browser.Document != null && browser.Document.Body != null)
            {
                Rectangle content = browser.Document.Body.ScrollRectangle;
                int desiredWidth = Math.Max(content.Width, width);
                int desiredHeight = Math.Max(content.Height, height);
                width = Math.Min(desiredWidth, MaxEdge);
                height = Math.Min(Math.Min(desiredHeight, MaxEdge), MaxPixels / width);
                cropped = width < desiredWidth || height < desiredHeight;
                form.ClientSize = new Size(width, height);
                Application.DoEvents();
            }

            using (var bitmap = new Bitmap(width, height))
            using (var png = new MemoryStream())
            using (Stream output = Console.OpenStandardOutput())
            {
                browser.DrawToBitmap(bitmap, new Rectangle(0, 0, width, height));
                bitmap.Save(png, ImageFormat.Png);
                if (png.Length > MaxPng) throw new InvalidDataException("PNG output is too large");
                output.WriteByte(cropped ? (byte)1 : (byte)0);
                png.WriteTo(output);
            }
        }
    }
}
