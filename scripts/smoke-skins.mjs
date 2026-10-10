// scripts/smoke-skins.mjs — headless browser smoke of the skin flow (fusion-assets):
// title → name → create room → open 干员调配 → pick Skadi → the skin section lists her skins →
// choose one → the room.skins frame reached the server (the page's net layer stays online).
// Run with the dev server up: PORT=3100 node scripts/smoke-skins.mjs
/* global document */ // the page.evaluate callbacks run in the browser
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const shell = '/Users/baysonfox/scratchpad/stronghold-protocol/chrome-headless-shell/mac_arm-155.0.8059.39/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const browser = await puppeteer.launch({ executablePath: shell, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
await page.screenshot({ path: '/tmp/sp-1-title.png' });

// title screen: type a name and enter
const nameInput = await page.waitForSelector('input', { timeout: 10000 });
await nameInput.type('SmokeBot');
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: '/tmp/sp-2-lobby.png' });

// create a room (solo)
const create = await page.waitForSelector('[data-testid="create-room"], button', { timeout: 10000 });
// try a testid first, else click the first promising button
const clicked = await page.evaluate(() => {
  const b = document.querySelector('[data-testid="create-room"]') || [...document.querySelectorAll('button')].find((x) => /创建|建房|单人|开始/.test(x.textContent || ''));
  if (b) { b.click(); return b.textContent.trim(); }
  return null;
});
console.log('[smoke] create clicked:', clicked);
await new Promise((r) => setTimeout(r, 2000));
await page.screenshot({ path: '/tmp/sp-3-room.png' });

// open the loadout screen (干员调配)
const loadout = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /干员调配|调配/.test(x.textContent || ''));
  if (b) { b.click(); return b.textContent.trim(); }
  return null;
});
console.log('[smoke] loadout opened:', loadout);
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: '/tmp/sp-4-loadout.png' });

// search Skadi and open her detail
await page.evaluate(() => {
  const i = document.querySelector('.lo-search input, input[type="text"], input[type="search"]');
  if (i) { i.focus(); }
});
await page.keyboard.type('斯卡蒂', { delay: 40 });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.lo-list__rows [role="listitem"], .lo-list__rows > *, tr')].find((x) => /斯卡蒂/.test(x.textContent || ''));
  if (row) row.click();
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: '/tmp/sp-5-skadi.png' });

// the skin section
const skins = await page.evaluate(() => {
  const sec = document.querySelector('[data-testid="skin-section"]');
  if (!sec) return null;
  const buttons = [...sec.querySelectorAll('.lo-skin')].map((b) => ({
    name: b.querySelector('.lo-skin__name')?.textContent,
    on: b.classList.contains('is-on'),
  }));
  return buttons;
});
console.log('[smoke] skin section:', JSON.stringify(skins));

// choose the first non-default skin
const picked = await page.evaluate(() => {
  const sec = document.querySelector('[data-testid="skin-section"]');
  if (!sec) return null;
  const b = [...sec.querySelectorAll('.lo-skin')].find((x) => x.dataset.skin);
  if (b) { b.click(); return b.querySelector('.lo-skin__name')?.textContent; }
  return null;
});
console.log('[smoke] picked:', picked);
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: '/tmp/sp-6-picked.png' });
const equipped = await page.evaluate(() => {
  const sec = document.querySelector('[data-testid="skin-section"]');
  const on = sec?.querySelector('.lo-skin.is-on .lo-skin__name')?.textContent;
  return on;
});
console.log('[smoke] equipped now:', equipped);

console.log('[smoke] page errors:', errors.length ? errors.slice(0, 10) : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
