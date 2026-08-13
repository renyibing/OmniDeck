import { chromium } from 'playwright';

const baseUrl = process.env.OMNIDECK_WEB_URL ?? 'http://127.0.0.1:5173';
const apiRequests = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('request', request => {
  const url = request.url();
  if (url.includes('/api/devices/') && ['scroll', 'input-text', 'press-key'].some(part => url.includes(part))) {
    apiRequests.push({ method: request.method(), url, body: request.postData() });
  }
});

await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.device-tile', { timeout: 15000 });
await page.waitForTimeout(1500);

// Prefer an iOS tile that is already under human control; otherwise take control via inspector.
const humanIosTile = page.locator('.device-tile.human').filter({ hasText: 'IOS' }).first();
if (await humanIosTile.count()) {
  await humanIosTile.click();
} else {
  const iosTile = page.locator('.device-tile').filter({ hasText: 'IOS' }).first();
  await iosTile.click();
  const takeover = page.locator('.takeover-button').first();
  if (await takeover.count()) {
    const label = (await takeover.textContent())?.trim() ?? '';
    if (label.includes('Take control')) await takeover.click();
  }
}

const viewport = page.locator('.screen-fit-viewport').first();
await viewport.waitFor({ state: 'visible', timeout: 10000 });
await viewport.click();
await viewport.focus();

await page.keyboard.type('z');
await page.keyboard.press('Enter');
const box = await viewport.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
} else {
  await viewport.dispatchEvent('wheel', { deltaX: 0, deltaY: 120 });
}

await page.waitForTimeout(800);

const scrollHits = apiRequests.filter(item => item.url.includes('/scroll'));
const textHits = apiRequests.filter(item => item.url.includes('/input-text'));
const keyHits = apiRequests.filter(item => item.url.includes('/press-key'));

console.log(JSON.stringify({
  baseUrl,
  apiRequests,
  scrollHits: scrollHits.length,
  textHits: textHits.length,
  keyHits: keyHits.length,
  ok: scrollHits.length > 0 && textHits.length > 0 && keyHits.length > 0,
}, null, 2));

await browser.close();
process.exit(scrollHits.length > 0 && textHits.length > 0 && keyHits.length > 0 ? 0 : 1);
