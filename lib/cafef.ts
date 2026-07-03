import axios from 'axios';
import * as cheerio from 'cheerio';

export interface NewsItem {
  title: string;
  link: string;
  description?: string;
  // The source site's own short lead/dẫn nhập (CafeF's listing-page "sapo",
  // VnExpress RSS's contentSnippet) - used verbatim for mục that skip AI
  // summarization instead of the full fetched article body.
  intro?: string;
  source: string;
  publishedAt: string;
  pubDate?: string;
  category?: string;
}

const CATEGORY_SOURCES = [
  { url: 'https://cafef.vn/thi-truong-chung-khoan.chn', category: 'Thị trường chứng khoán' },
  { url: 'https://cafef.vn/bat-dong-san.chn', category: 'Bất động sản' },
  { url: 'https://cafef.vn/doanh-nghiep.chn', category: 'Doanh nghiệp' },
  { url: 'https://cafef.vn/tai-chinh-ngan-hang.chn', category: 'Tài chính ngân hàng' },
  { url: 'https://cafef.vn/tai-chinh-quoc-te.chn', category: 'Tài chính quốc tế' },
  { url: 'https://cafef.vn/vi-mo-dau-tu.chn', category: 'Vĩ mô đầu tư' },
  { url: 'https://cafef.vn/thi-truong.chn', category: 'Thị trường' },
  { url: 'https://cafef.vn/xa-hoi.chn', category: 'Xã hội' },
];

const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_HEADERS = { 'User-Agent': 'Mozilla/5.0' };
const ARTICLE_SELECTOR = '.tlitem.box-category-item';
// Safety valve: timeline pages paginate 15 items/page, this bounds runaway
// pagination if the 24h cutoff is somehow never hit (e.g. site format change).
const MAX_PAGES_PER_CATEGORY = 30;
const ARTICLE_BODY_SELECTOR = '.detail-content';
const MAX_DESCRIPTION_CHARS = 2000;
// Cafef listing titles are often deliberately vague clickbait (e.g. "một cổ
// phiếu", "một ngân hàng") - the specific names only show up in the article
// body, so it has to be fetched separately from the listing page.
const ARTICLE_FETCH_CONCURRENCY = 8;

interface RawArticle {
  title: string;
  href: string;
  timeText: string;
  intro: string;
}

function normalizeLink(href: string): string {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  if (href.startsWith('//')) return `https:${href}`;
  return `https://cafef.vn${href.startsWith('/') ? href : `/${href}`}`;
}

// Cafef renders an absolute "YYYY-MM-DDTHH:mm:00" timestamp in Vietnam time
// but without a timezone suffix. Parsing that bare string would make JS
// interpret it as the *runtime's* local time - UTC on Vercel/GitHub Actions -
// silently shifting every timestamp by 7 hours. Append the explicit VN offset
// so the string is unambiguous regardless of where this code runs.
function parsePublishedAt(timeText: string): Date | null {
  const trimmed = timeText.trim();

  // The pinned "nổi bật" box at the top of a category page renders its
  // timestamp as visible "DD/MM/YYYY - HH:mm" text instead of the .time-ago
  // ISO title used by regular listing items (its own data-time attribute is
  // buggy - CafeF's template mangles the day, e.g. "202\07\2026 - 00:07" for
  // "02/07/2026 - 00:07" - so the visible text is the only reliable source).
  const vnFormat = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2}):(\d{2})$/);
  if (vnFormat) {
    const [, dd, mm, yyyy, hh, min] = vnFormat;
    const date = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00+07:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const date = new Date(hasOffset ? trimmed : `${trimmed}+07:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractArticles($: cheerio.CheerioAPI): RawArticle[] {
  const articles: RawArticle[] = [];

  $(ARTICLE_SELECTOR).each((_, node) => {
    const el = $(node);
    const linkEl = el.find('h3 a').first();
    const timeEl = el.find('.time-ago').first();
    const introEl = el.find('.sapo.box-category-sapo').first();

    articles.push({
      title: linkEl.text().trim(),
      href: linkEl.attr('href') || '',
      timeText: timeEl.attr('title') || timeEl.text().trim(),
      intro: introEl.text().trim(),
    });
  });

  return articles;
}

// The top of every category page pins ~3 "nổi bật" articles in a
// `.list-focus-main` box (1 big `.firstitem` + 2 `.big` items in
// `.cate-hl-row2`) that sits outside the regular `.tlitem.box-category-item`
// list ARTICLE_SELECTOR matches - without this they're silently skipped.
// Only the first (non-paginated) page has this box.
function extractHighlightArticles($: cheerio.CheerioAPI): RawArticle[] {
  const articles: RawArticle[] = [];

  const firstItem = $('.list-focus-main .firstitem').first();
  if (firstItem.length) {
    const linkEl = firstItem.find('.hl-info h2 a').first();
    articles.push({
      title: linkEl.text().trim(),
      href: linkEl.attr('href') || '',
      timeText: firstItem.find('.hl-info p.time').first().text().trim(),
      intro: firstItem.find('.hl-info p.sapo').first().text().trim(),
    });
  }

  $('.list-focus-main .cate-hl-row2 [role="article"]').each((_, node) => {
    const el = $(node);
    const linkEl = el.find('h3 a').first();
    articles.push({
      title: linkEl.text().trim(),
      href: linkEl.attr('href') || '',
      timeText: el.find('p.time').first().text().trim(),
      intro: el.find('p.sapo').first().text().trim(),
    });
  });

  return articles;
}

// Each category page embeds its CMS zone id (e.g. "newsinzone:zone18831"),
// which is also the id CafeF's own infinite-scroll widget uses to fetch
// further pages - reusing it lets us paginate without a hardcoded table.
function extractZoneId($: cheerio.CheerioAPI): string | null {
  const key = $('[data-cd-key*="newsinzone"]').first().attr('data-cd-key') || '';
  const match = key.match(/zone(\d+)/);
  return match ? match[1] : null;
}

async function fetchPage(url: string): Promise<cheerio.CheerioAPI> {
  const { data } = await axios.get<string>(url, {
    headers: REQUEST_HEADERS,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return cheerio.load(data);
}

async function fetchArticleExcerpt(link: string): Promise<string> {
  try {
    const $ = await fetchPage(link);
    const paragraphs = $(`${ARTICLE_BODY_SELECTOR} p`)
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean);

    return paragraphs.join(' ').slice(0, MAX_DESCRIPTION_CHARS);
  } catch (error) {
    console.error('cafef article body error', link, error);
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

async function crawlCategory(url: string, category: string, cutoff: number): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  const seen = new Set<string>();

  const firstPage = await fetchPage(url);
  const zoneId = extractZoneId(firstPage);
  if (!zoneId) {
    console.error('cafef zone id not found', url);
  }

  for (let pageIndex = 1; pageIndex <= MAX_PAGES_PER_CATEGORY; pageIndex++) {
    const $ = pageIndex === 1 ? firstPage : await fetchPage(`https://cafef.vn/timelinelist/${zoneId}/${pageIndex}.chn`);

    const rawArticles = pageIndex === 1 ? [...extractHighlightArticles($), ...extractArticles($)] : extractArticles($);
    if (!rawArticles.length) break;

    let reachedCutoff = false;
    for (const article of rawArticles) {
      const publishedAt = parsePublishedAt(article.timeText);
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
        intro: article.intro,
        source: 'CafeF',
        publishedAt: publishedAt.toISOString(),
        pubDate: publishedAt.toISOString(),
        category,
      });
    }

    if (reachedCutoff || !zoneId) break;
  }

  return items;
}

export async function fetchCafeFNews(hours = 24, categories?: string[]): Promise<NewsItem[]> {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const sources = categories?.length
    ? CATEGORY_SOURCES.filter((source) => categories.includes(source.category))
    : CATEGORY_SOURCES;

  const results = await Promise.allSettled(
    sources.map(({ url, category }) => crawlCategory(url, category, cutoff))
  );

  const items = results.flatMap((result) => {
    if (result.status === 'fulfilled') return result.value;
    console.error('cafef crawl error', result.reason);
    return [];
  });

  const descriptions = await mapWithConcurrency(items, ARTICLE_FETCH_CONCURRENCY, (item) =>
    fetchArticleExcerpt(item.link)
  );
  items.forEach((item, index) => {
    item.description = descriptions[index];
  });

  return items;
}
