import puppeteer from 'puppeteer-core';

// Opens a headless Chrome and closes it. Proves the bundle can drive a browser.
export async function checkBrowser(): Promise<string> {
  const browser = await puppeteer.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>uiwalk check</title><p>ok</p>');
    const title = await page.title();
    const version = await browser.version();
    return `Chrome works: ${version}, page title "${title}"`;
  } finally {
    await browser.close();
  }
}
