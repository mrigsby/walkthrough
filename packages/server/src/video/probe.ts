import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'puppeteer-core';

// True when this Chrome can encode H.264, so MP4 needs no ffmpeg.
// VideoEncoder only exists on a secure page, so this loads an empty page from 127.0.0.1.
export async function chromeCanMakeMp4(browser: Browser): Promise<boolean> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>uiwalk</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    return await page.evaluate(async () => {
      if (typeof VideoEncoder !== 'function') return false;
      const result = await VideoEncoder.isConfigSupported({
        codec: 'avc1.42001f',
        width: 1280,
        height: 720,
      });
      return Boolean(result.supported);
    });
  } catch {
    return false;
  } finally {
    await page.close().catch(() => undefined);
    server.close();
  }
}
