import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'docs/.vitepress/dist');
const artifacts = path.join(root, 'research/docs-preview');
const base = `/${(process.env.VITEPRESS_BASE ?? '').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
await access(path.join(dist, 'index.html')).catch(() => { throw new Error('Сначала выполните npm run docs:build.'); });
const published = await readdir(dist);
for (const internal of ['guide', 'research', 'internal']) {
  assert.equal(published.includes(internal), false, `В публикацию попал внутренний раздел: ${internal}`);
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (!pathname.startsWith(base)) { response.writeHead(404).end(); return; }
    const relative = pathname.slice(base.length) || 'index.html';
    const filename = path.resolve(dist, relative.endsWith('/') ? `${relative}index.html` : relative);
    if (!filename.startsWith(`${dist}${path.sep}`)) { response.writeHead(403).end(); return; }
    const body = await readFile(filename);
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

async function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const command of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      const candidate = path.join(directory, command);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* Next candidate. */ }
    }
  }
}

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: await findBrowser() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const architecture = `${base}spec/architecture.html`;
  const constructor = `${base}spec/constructor.html`;
  const diagramSelector = '.mermaid-container .mermaid svg';
  async function waitForDiagram() {
    // Renderer replaces the original fence node. Scroll inside one JS task,
    // without keeping an element handle across the replacement.
    await page.waitForFunction(() => {
      const diagram = document.querySelector('.mermaid-container, .language-mermaid');
      if (!diagram) return false;
      diagram.scrollIntoView({ block: 'center', behavior: 'instant' });
      return true;
    });
    await page.locator(diagramSelector).first().waitFor();
  }

  await page.goto(`${origin}${base}`, { waitUntil: 'networkidle' });
  await page.locator('main h1').waitFor();
  const cover = await page.locator('main').innerText();
  assert.match(cover, /CMS Strapi/, 'Основной объём должен включать CMS Strapi.');
  assert.match(cover, /Ozon Pay/, 'Действующая оплата должна входить в проект.');
  assert.equal(await page.locator('a[href*="/guide/"], a[href*="/research/"], a[href*="/internal/"]').count(), 0,
    'В навигацию заказчика попали внутренние материалы.');
  await page.goto(`${origin}${architecture}#p-7-3-1`, { waitUntil: 'networkidle' });
  const backupPoint = page.locator('#p-7-3-1');
  await backupPoint.waitFor();
  assert.match(await backupPoint.textContent(), /^7\.3\.1\./, 'Нумерация пункта не отображается.');
  assert.equal(await backupPoint.locator('.header-anchor').getAttribute('href'), '#p-7-3-1',
    'Заголовок должен содержать прямую ссылку на пункт.');
  await waitForDiagram();
  const zoom = page.locator('.mermaid-container .zoom-level:visible').first();
  const beforeZoom = await zoom.textContent();
  await page.locator('[data-mermaid-control="zoomIn"]:visible').first().click();
  assert.notEqual(await zoom.textContent(), beforeZoom, 'Масштабирование диаграммы не работает.');

  const previousSvg = await page.locator(diagramSelector).first().evaluate((node) => node.outerHTML);
  await page.locator('.VPSwitchAppearance:visible').first().click();
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await page.waitForFunction(({ selector, previous }) => {
    const svg = document.querySelector(selector);
    return svg && svg.outerHTML !== previous;
  }, { selector: diagramSelector, previous: previousSvg });
  await page.locator(diagramSelector).first().waitFor();

  // VitePress client navigation must initialise diagrams again.
  await page.locator(`a[href="${constructor}"]:visible`).first().click();
  await page.waitForURL(`**${constructor}`);
  await page.locator(`a[href="${architecture}"]:visible`).first().click();
  await page.waitForURL(`**${architecture}`);
  await waitForDiagram();
  assert.equal(await page.locator('.diagram-error').count(), 0, 'Renderer показал ошибку диаграммы.');
  await page.locator('[data-mermaid-control="toggleFullscreen"]:visible').first().click();
  await page.locator('.mermaid-container.dialog-fullscreen-active').waitFor();
  await page.locator('.dialog-fullscreen-active [data-mermaid-control="toggleFullscreen"]:visible').first().click();
  await page.locator('.mermaid-container.dialog-fullscreen-active').waitFor({ state: 'hidden' });

  await page.locator('.VPNavBarSearch button').first().click();
  await page.locator('#localsearch-input').fill('конструктор');
  await page.locator('.VPLocalSearchBox a.result').first().waitFor();
  const searchResults = await page.locator('.VPLocalSearchBox a.result').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  assert.ok(searchResults.every((href) => new URL(href, origin).pathname.startsWith(base)), 'Поиск потерял путь публикации.');
  await page.keyboard.press('Escape');
  await page.locator('.VPLocalSearchBox').waitFor({ state: 'hidden' });

  await page.goto(`${origin}${base}spec/admin.html`, { waitUntil: 'networkidle' });
  await page.locator('#p-6-1-3').waitFor();
  assert.match(await page.locator('main h1').textContent(), /CMS/, 'Нужен раздел управления через CMS.');
  await page.goto(`${origin}${base}spec/leads.html`, { waitUntil: 'networkidle' });
  await page.locator('#p-5-2-2').waitFor();
  assert.match(await page.locator('#p-5-2-2').textContent(), /Ozon Pay/);
  await waitForDiagram();
  assert.equal(await page.locator('.diagram-error').count(), 0, 'Схема оформления заказа не отобразилась.');
  await page.goto(`${origin}${architecture}`, { waitUntil: 'networkidle' });
  await waitForDiagram();

  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.VPSidebar');
    return !sidebar || sidebar.getBoundingClientRect().right <= 1;
  });
  await waitForDiagram();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  assert.equal(overflow, false, 'На мобильном экране страница выходит за границы окна.');
  await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, [], `Ошибки браузера:\n${errors.join('\n')}`);
  console.log(`Документация проверена: диаграммы, масштаб, полный экран, тема, поиск, переходы, мобильный экран; base=${base}`);
  console.log(`Снимки экранов: ${artifacts}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
