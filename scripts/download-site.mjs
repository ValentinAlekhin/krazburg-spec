#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, writeFile, appendFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const HELP = `Загрузчик доступной браузеру части сайта.

  npm run download:site -- --url https://krazburg.ru [параметры]

  --url URL             Адрес сайта (по умолчанию https://krazburg.ru)
  --out PATH            Папка результата; должна отсутствовать или быть пустой
  --browser-path PATH   Путь к Chrome/Chromium (можно также CHROME_PATH)
  --timeout MS          Тайм-аут открытия страницы (по умолчанию 30000)
  --headless            Запуск без окна, для автоматического снимка
  --duration SECONDS    Ожидание после загрузки в headless (по умолчанию 5)
  --help                Эта справка

В окне браузера вручную пройдите конструктор, не отправляя заявку.
В терминале: Enter или save НАЗВАНИЕ — сохранить экран и HTML;
q или quit — сохранить итог и закончить; Ctrl+C — закончить досрочно.
Скрипт не отключает VPN и не получает серверные исходники.
`;

function parseArgs(args) {
  const options = { url: 'https://krazburg.ru', timeout: 30000, duration: 5, headless: false };
  const values = { '--url': 'url', '--out': 'out', '--browser-path': 'browserPath', '--timeout': 'timeout', '--duration': 'duration' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--headless') { options.headless = true; continue; }
    if (!values[arg]) throw new Error(`Неизвестный параметр: ${arg}. См. --help.`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Не указано значение ${arg}.`);
    options[values[arg]] = value;
  }
  let url;
  try { url = new URL(options.url); } catch { throw new Error('Укажите полный URL: https://example.com.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Допускается только HTTP(S) URL без логина и пароля.');
  }
  options.url = url.href;
  options.timeout = Number(options.timeout);
  options.duration = Number(options.duration);
  if (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout > 300000) {
    throw new Error('--timeout должен быть числом от 1 до 300000 мс.');
  }
  if (!Number.isFinite(options.duration) || options.duration < 0 || options.duration > 3600) {
    throw new Error('--duration должен быть числом от 0 до 3600 секунд.');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  options.out = path.resolve(options.out ?? `research/${url.hostname}-${stamp}`);
  return options;
}

async function browserPath(explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    await access(resolved, constants.X_OK).catch(() => { throw new Error(`Браузер не найден или не исполняемый: ${resolved}`); });
    return resolved;
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const command of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      const candidate = path.join(directory, command);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try next. */ }
    }
  }
  return undefined;
}

const now = () => new Date().toISOString();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const MAX_BODY_BYTES = 25 * 1024 * 1024;

function extension(url, contentType) {
  const types = { 'text/html': '.html', 'text/css': '.css', 'text/javascript': '.js', 'application/javascript': '.js', 'application/json': '.json', 'image/svg+xml': '.svg' };
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (types[mime]) return types[mime];
  const suffix = path.posix.extname(new URL(url).pathname);
  return /^\.[a-zA-Z0-9]{1,10}$/.test(suffix) ? suffix.toLowerCase() : '.bin';
}

async function download(options) {
  // Refuse to merge separate sessions or overwrite an existing capture.
  await mkdir(options.out, { recursive: true });
  if ((await readdir(options.out)).length) throw new Error(`Папка не пуста: ${options.out}. Выберите другую --out.`);
  await Promise.all(['assets', 'states'].map((dir) => mkdir(path.join(options.out, dir))));
  await writeFile(path.join(options.out, 'errors.jsonl'), '');

  const manifest = { schemaVersion: 1, sourceUrl: options.url, startedAt: now(), resources: [], states: [] };
  const pending = new Set();
  const requests = new Map();
  const pages = new Set();
  let browser, context, currentPage, terminal;
  let stopping = false;
  let interrupted = false;
  let fatal = null;
  let loggingFailed = null;
  let errorCount = 0;
  let snapshotFailures = 0;
  let stop;
  const stopped = new Promise((resolve) => { stop = resolve; });
  let snapshotQueue = Promise.resolve();

  function track(promise) {
    const task = promise.catch((error) => { loggingFailed ??= error.message; }).finally(() => pending.delete(task));
    pending.add(task);
    return task;
  }

  function report(type, details) {
    errorCount++;
    return track(appendFile(path.join(options.out, 'errors.jsonl'), JSON.stringify({ time: now(), type, ...details }) + '\n'));
  }

  async function persist() {
    await writeFile(path.join(options.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }

  function observePage(page) {
    pages.add(page);
    currentPage = page;
    page.on('console', (message) => {
      if (message.type() === 'error') report('console', { url: page.url(), message: message.text() });
    });
    page.on('pageerror', (error) => report('javascript', { url: page.url(), message: error.message }));
    page.on('close', () => {
      pages.delete(page);
      if (currentPage === page) currentPage = [...pages].at(-1);
      if (!pages.size && !stopping) { interrupted = true; stop(); }
    });
  }

  async function captureResponse(request) {
    const entry = requests.get(request);
    if (!entry || entry.captureStatus !== 'pending') return;
    try {
      const response = await request.response();
      if (!response) throw new Error('Нет ответа браузера.');
      if (entry.status >= 300 && entry.status < 400) { entry.captureStatus = 'redirect'; return; }
      const length = Number(response.headers()['content-length'] ?? 0);
      if (length > MAX_BODY_BYTES) {
        entry.captureStatus = 'skipped'; entry.reason = 'Ответ больше 25 МиБ.'; return;
      }
      const body = await response.body();
      if (body.length > MAX_BODY_BYTES) {
        entry.captureStatus = 'skipped'; entry.reason = 'Распакованный ответ больше 25 МиБ.'; return;
      }
      entry.sha256 = hash(body);
      entry.bytes = body.length;
      entry.savedAs = `assets/${hash(entry.url).slice(0, 16)}-${entry.sha256.slice(0, 16)}${extension(entry.url, entry.contentType)}`;
      await writeFile(path.join(options.out, entry.savedAs), body);
      entry.captureStatus = 'saved';
      entry.finishedAt = now();
    } catch (error) {
      entry.captureStatus = 'failed';
      entry.reason = error.message;
      report('resource-save', { url: entry.url, message: error.message });
    }
  }

  function snapshot(name) {
    snapshotQueue = snapshotQueue.then(async () => {
      const page = currentPage;
      if (!page || page.isClosed()) return;
      const number = String(manifest.states.length + 1).padStart(3, '0');
      const slug = name.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'state';
      const stem = `states/${number}-${slug}`;
      try {
        const html = await page.content();
        await writeFile(path.join(options.out, `${stem}.html`), html);
        await page.screenshot({ path: path.join(options.out, `${stem}.png`), fullPage: true, timeout: 10000, animations: 'disabled' });
        manifest.states.push({ name, url: page.url(), time: now(), html: `${stem}.html`, screenshot: `${stem}.png` });
        await persist();
        console.log(`Сохранён шаг: ${name}`);
      } catch (error) {
        snapshotFailures++;
        report('snapshot', { name, message: error.message });
        console.error(`Не удалось сохранить шаг «${name}»: ${error.message}`);
      }
    });
    return snapshotQueue;
  }

  function onInterrupt() { interrupted = true; stop(); }
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    const { chromium } = await import('playwright');
    const executablePath = await browserPath(options.browserPath ?? process.env.CHROME_PATH);
    console.log(`Результаты: ${options.out}`);
    console.log(executablePath ? `Браузер: ${executablePath}` : 'Браузер: Chromium Playwright');
    browser = await chromium.launch({
      headless: options.headless, executablePath,
      handleSIGINT: false, handleSIGTERM: false,
    });
    browser.on('disconnected', () => { if (!stopping) { interrupted = true; stop(); } });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false });
    context.setDefaultTimeout(10000);
    await context.exposeBinding('__krazburgCaptureFocus', ({ page }) => { currentPage = page; });
    await context.addInitScript(() => {
      const active = () => {
        if (document.visibilityState === 'visible') window.__krazburgCaptureFocus().catch(() => {});
      };
      window.addEventListener('focus', active);
      document.addEventListener('visibilitychange', active);
      active();
    });
    context.on('page', observePage);
    context.on('request', (request) => {
      if (request.method() !== 'GET' || !/^https?:\/\//.test(request.url())) return;
      const entry = { url: request.url(), method: 'GET', resourceType: request.resourceType(), requestedAt: now(), status: null, contentType: '', captureStatus: 'pending' };
      requests.set(request, entry);
      manifest.resources.push(entry);
    });
    context.on('response', (response) => {
      const entry = requests.get(response.request());
      if (!entry) return;
      entry.status = response.status();
      entry.contentType = response.headers()['content-type'] ?? '';
      entry.respondedAt = now();
      if (entry.status >= 400) report('http', { url: entry.url, status: entry.status });
    });
    context.on('requestfinished', (request) => track(captureResponse(request)));
    context.on('requestfailed', (request) => {
      const entry = requests.get(request);
      if (!entry) return;
      entry.captureStatus = 'failed';
      entry.reason = request.failure()?.errorText ?? 'Неизвестная ошибка сети.';
      report('network', { url: entry.url, message: entry.reason });
    });
    currentPage = await context.newPage();
    const response = await Promise.race([
      currentPage.goto(options.url, { waitUntil: 'domcontentloaded', timeout: options.timeout }),
      stopped.then(() => {
        const error = new Error('Загрузка прервана пользователем.');
        error.name = 'CaptureInterrupted';
        throw error;
      }),
    ]);
    if (!response || response.status() >= 400) throw new Error(`Сайт вернул ${response?.status() ?? 'пустой ответ'}.`);
    await snapshot('initial');

    if (options.headless) {
      let timer;
      await Promise.race([stopped, new Promise((resolve) => { timer = setTimeout(resolve, options.duration * 1000); })]);
      clearTimeout(timer);
    } else {
      if (!process.stdin.isTTY) throw new Error('Для работы с окном нужен интерактивный терминал. Используйте --headless для автоматического снимка.');
      console.log('\nПройдите конструктор в браузере. Не отправляйте заявку.');
      console.log('Enter / save НАЗВАНИЕ — сохранить шаг; q / quit — закончить.');
      terminal = createInterface({ input: process.stdin, output: process.stdout });
      terminal.on('SIGINT', onInterrupt);
      terminal.on('line', (line) => {
        const command = line.trim();
        if (/^(q|quit)$/i.test(command)) { stop(); return; }
        if (!command || /^save(?:\s|$)/i.test(command)) {
          void snapshot(command.replace(/^save\s*/i, '') || 'step');
        } else { console.log('Команды: Enter, save НАЗВАНИЕ, q.'); }
      });
      terminal.on('close', () => { if (!stopping) { interrupted = true; stop(); } });
      await stopped;
    }
  } catch (error) {
    if (error.name === 'CaptureInterrupted') {
      console.log(error.message);
    } else {
      fatal = error.message;
      report('fatal', { message: fatal });
      console.error(`Ошибка: ${fatal}`);
    }
    if (/Executable doesn't exist|browserType.launch/.test(fatal ?? '')) {
      console.error('Установите браузер: npx playwright install chromium; либо укажите --browser-path /путь/к/chrome.');
    }
    if (/ERR_NAME_NOT_RESOLVED/.test(fatal ?? '')) console.error('DNS не определяет адрес сайта. Проверьте подключение и VPN; затем повторите с новой папкой --out.');
  } finally {
    stopping = true;
    terminal?.close();
    await snapshotQueue;
    await snapshot('final');
    // Freeze the capture boundary. Read completed response bodies before closing
    // the context: Playwright cannot retrieve them after the browser is gone.
    if (context) {
      for (const event of ['request', 'response', 'requestfinished', 'requestfailed']) {
        await context.removeAllListeners(event);
      }
    }
    while (pending.size) await Promise.allSettled([...pending]);
    await context?.close().catch((error) => report('browser-close', { message: error.message }));
    await browser?.close().catch(() => {});
    while (pending.size) await Promise.allSettled([...pending]);
    for (const entry of manifest.resources) {
      if (entry.captureStatus === 'pending') { entry.captureStatus = 'skipped'; entry.reason = 'Запрос не завершился до конца сеанса.'; }
    }
    manifest.finishedAt = now();
    await persist();
    const saved = manifest.resources.filter((r) => r.captureStatus === 'saved').length;
    const failed = manifest.resources.filter((r) => r.captureStatus === 'failed' || r.status >= 400).length;
    const skipped = manifest.resources.filter((r) => r.captureStatus === 'skipped').length;
    const status = fatal || loggingFailed ? 'failed' : (failed || skipped || interrupted || snapshotFailures || errorCount ? 'partial' : 'complete');
    const summary = { schemaVersion: 1, sourceUrl: options.url, startedAt: manifest.startedAt, finishedAt: manifest.finishedAt, status, interrupted, savedResources: saved, failedResources: failed, skippedResources: skipped, states: manifest.states.length, errors: errorCount, fatal: fatal ?? loggingFailed, maxResourceBytes: MAX_BODY_BYTES };
    await writeFile(path.join(options.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    console.log(`\nИтог: ${status}. Ресурсов сохранено: ${saved}; ошибок ресурсов: ${failed}; пропущено: ${skipped}; снимков: ${manifest.states.length}.`);
    console.log(`Отчёт: ${path.join(options.out, 'summary.json')}`);
    process.exitCode = status === 'failed' ? 1 : status === 'partial' ? 2 : 0;
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) console.log(HELP);
  else await download(options);
} catch (error) {
  console.error(`Ошибка: ${error.message}`);
  process.exitCode = 1;
}
