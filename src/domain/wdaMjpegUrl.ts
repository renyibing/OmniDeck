/** Derive WDA MJPEG URL from the control URL (8100 -> 9100 by Appium convention). */
export function deriveWdaMjpegUrl(wdaUrl: string | null | undefined): string | null {
  if (!wdaUrl) return null;
  try {
    const url = new URL(wdaUrl);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!Number.isFinite(port) || port <= 0) return null;
    url.port = String(port + 1000);
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
