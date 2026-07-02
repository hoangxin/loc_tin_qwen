import { existsSync } from 'fs';
import axios from 'axios';
import * as cheerio from 'cheerio';
import chromium from '@sparticuz/chromium';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { NewsItem } from '@/lib/cafef';

const CATEGORY_SOURCES = [
  { url: 'https://vietstock.vn/chung-khoan.htm', category: 'Chứng khoán' },
  { url: 'https://vietstock.vn/doanh-nghiep.htm', category: 'Doanh nghiệp' },
  { url: 'https://vietstock.vn/bat-dong-san.htm', category: 'Bất động sản' },
  { url: 'https://vietstock.vn/tai-chinh.htm', category: 'Tài chính' },
  { url: 'https://vietstock.vn/hang-hoa.htm', category: 'Hàng hóa' },
  { url: 'https://vietstock.vn/kinh-te.htm', category: 'Kinh tế' },
  { url: 'https://vietstock.vn/the-gioi.htm', category: 'Thế giới' },
];

const PAGE_TIMEOUT_MS = 30000;
const ARTICLE_SELECTOR = '.channelContent';
const NEXT_PAGE_SELECTOR = 'a[title="Trang sau"]';
// Safety valve: channel pages paginate 10 items/click, this bounds runaway
// pagination if the 24h cutoff is somehow never hit (e.g. site format change).
const MAX_PAGES_PER_CATEGORY = 30;
const ARTICLE_BODY_SELECTOR = '.article-content';
const MAX_DESCRIPTION_CHARS = 2000;
// Article detail pages are static HTML (no JS needed), so they're fetched
// with plain axios instead of Puppeteer - the single-process chromium
// instance used for listing pages can't cheaply host ~100 extra tabs.
const ARTICLE_FETCH_CONCURRENCY = 8;

const LOCAL_CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((path): path is string => Boolean(path));

interface RawArticle {
  title: string;
  href: string;
  timeText: string;
}

// The sparticuz/chromium launch args (--single-process, --no-zygote, ...)
// are tuned for AWS Lambda's constrained, single-request containers. A local
// desktop Chrome install doesn't need — and is destabilized by — those
// flags, so local dev launches with plain defaults instead.
export async function launchBrowser(): Promise<Browser> {
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const localChrome = isServerless ? undefined : LOCAL_CHROME_CANDIDATES.find((path) => existsSync(path));

  if (localChrome) {
    // GitHub Actions runners execute as root, and Chrome's sandbox refuses
    // to start under root without this flag ("Failed to launch the browser
    // process!"). Harmless on a local desktop Chrome too.
    return puppeteer.launch({ executablePath: localChrome, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }

  return puppeteer.launch({
    executablePath: await chromium.executablePath(),
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    headless: chromium.headless,
  });
}

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

// Vietstock's "DD/MM HH:mm" / "DD/MM/YYYY HH:mm" timestamps are Vietnam
// wall-clock time. Building a Date from those Y/M/D/H/m fields with the local
// Date constructor would interpret them in the *runtime's* timezone - UTC on
// Vercel/GitHub Actions - silently shifting every timestamp by 7 hours. This
// builds the equivalent UTC instant directly instead.
function vnWallClockToDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - VN_OFFSET_MS);
}

// Vietstock renders "X phút/giờ trước" for recent items and "DD/MM HH:mm"
// (year implied) for older ones on the same channel page.
function parsePublishedAt(timeText: string, now: Date): Date | null {
  const text = timeText.trim();

  const relativeMatch = text.match(/^(\d+)\s*(phút|giờ)\s*trước$/i);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unitMs = relativeMatch[2].toLowerCase() === 'phút' ? 60_000 : 3_600_000;
    return new Date(now.getTime() - amount * unitMs);
  }

  // `now` shifted into Vietnam wall-clock terms, to fill in the year the
  // short format omits.
  const nowVN = new Date(now.getTime() + VN_OFFSET_MS);

  const shortMatch = text.match(/^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (shortMatch) {
    const [, day, month, hour, minute] = shortMatch;
    const year = nowVN.getUTCFullYear();
    let candidate = vnWallClockToDate(year, Number(month), Number(day), Number(hour), Number(minute));
    if (candidate.getTime() > now.getTime() + 60_000) {
      candidate = vnWallClockToDate(year - 1, Number(month), Number(day), Number(hour), Number(minute));
    }
    return candidate;
  }

  const fullMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (fullMatch) {
    const [, day, month, year, hour, minute] = fullMatch;
    return vnWallClockToDate(Number(year), Number(month), Number(day), Number(hour), Number(minute));
  }

  return null;
}

function normalizeLink(href: string): string {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  return `https://vietstock.vn${href.startsWith('/') ? href : `/${href}`}`;
}

async function extractArticles(page: Page): Promise<RawArticle[]> {
  return page.$$eval(ARTICLE_SELECTOR, (nodes) =>
    nodes.map((node) => {
      const linkEl = node.querySelector('h4 a.fontbold');
      const timeEl = node.querySelector('.meta3 a:nth-child(2)');
      return {
        title: linkEl?.textContent?.trim() || '',
        href: linkEl?.getAttribute('href') || '',
        timeText: timeEl?.textContent?.trim() || '',
      };
    })
  );
}

async function fetchArticleExcerpt(link: string): Promise<string> {
  try {
    const { data } = await axios.get<string>(link, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: PAGE_TIMEOUT_MS,
    });
    const $ = cheerio.load(data);
    const paragraphs = $(`${ARTICLE_BODY_SELECTOR} p`)
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean);

    return paragraphs.join(' ').slice(0, MAX_DESCRIPTION_CHARS);
  } catch (error) {
    console.error('vietstock article body error', link, error);
    return '';
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function crawlCategory(
  browser: Browser,
  url: string,
  category: string,
  cutoff: number,
  now: Date
): Promise<NewsItem[]> {
  const page = await browser.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(ARTICLE_SELECTOR);

    const items: NewsItem[] = [];
    const seen = new Set<string>();

    for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_CATEGORY; pageIndex++) {
      const rawArticles = await extractArticles(page);
      if (!rawArticles.length) break;

      let reachedCutoff = false;
      for (const article of rawArticles) {
        const publishedAt = parsePublishedAt(article.timeText, now);
        if (!publishedAt) continue;
        if (publishedAt.getTime() < cutoff) {
          reachedCutoff = true;
          continue;
        }

        const link = normalizeLink(article.href);
        if (!link || !article.title || seen.has(link)) continue;
        seen.add(link);

        items.push({
          title: article.title,
          link,
          description: '',
          source: 'Vietstock',
          publishedAt: publishedAt.toISOString(),
          pubDate: publishedAt.toISOString(),
          category,
        });
      }

      if (reachedCutoff) break;

      const hasNextButton = await page.$eval(NEXT_PAGE_SELECTOR, () => true).catch(() => false);
      if (!hasNextButton) break;

      // Puppeteer's native ElementHandle.click() (visibility/position checks,
      // then a synthesized mouse event) hangs on this element - confirmed by
      // hand against the live site. A plain in-page el.click() works
      // reliably, so dispatch it via evaluate instead.
      const firstTitleBefore = rawArticles[0]?.title;
      try {
        await page.evaluate((selector) => {
          (document.querySelector(selector) as HTMLElement | null)?.click();
        }, NEXT_PAGE_SELECTOR);
        await page.waitForFunction(
          (selector, prevTitle) => {
            const el = document.querySelector(selector)?.querySelector('h4 a.fontbold');
            return Boolean(el) && el?.textContent?.trim() !== prevTitle;
          },
          {},
          ARTICLE_SELECTOR,
          firstTitleBefore
        );
      } catch (error) {
        // Don't let a pagination hiccup on page N discard everything already
        // collected from pages 1..N-1 - stop here and return what we have.
        console.error('vietstock pagination error', category, pageIndex + 1, error);
        break;
      }
    }

    return items;
  } finally {
    await page.close();
  }
}

export async function fetchVietstockNews(hours = 24): Promise<NewsItem[]> {
  const now = new Date();
  const cutoff = now.getTime() - hours * 60 * 60 * 1000;

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();

    // sparticuz/chromium runs with --single-process, which cannot reliably
    // host multiple concurrent pages/tabs — crawl categories one at a time.
    const allItems: NewsItem[] = [];
    for (const { url, category } of CATEGORY_SOURCES) {
      try {
        const items = await crawlCategory(browser, url, category, cutoff, now);
        allItems.push(...items);
      } catch (error) {
        console.error('vietstock crawl error', error);
      }
    }

    const descriptions = await mapWithConcurrency(allItems, ARTICLE_FETCH_CONCURRENCY, (item) =>
      fetchArticleExcerpt(item.link)
    );
    allItems.forEach((item, index) => {
      item.description = descriptions[index];
    });

    return allItems;
  } catch (error) {
    console.error('vietstock fetch error', error);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}
