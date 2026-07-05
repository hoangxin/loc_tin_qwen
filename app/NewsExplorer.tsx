'use client';

import { useState } from 'react';
import type { Digest } from '@/lib/digest';
import type { DigestGroup } from '@/lib/qwen';
import { formatTimestamp, splitPrTag } from '@/lib/format';
import TriggerDigestButton from './TriggerDigestButton';

// Fixed so both tabs always render even when one source has no data yet
// (e.g. its crawl failed on the last run) - a source silently disappearing
// from the tab bar would be confusing.
const KNOWN_SOURCES = ['CafeF', 'Vietstock', 'Vnexpress'];

// Display order for each source's mục tabs - doesn't match crawl/declaration
// order in cafef.ts/vietstock.ts/vnexpress.ts, so it has to be spelled out here.
const CATEGORY_ORDER: Record<string, string[]> = {
  CafeF: [
    'Thị trường chứng khoán',
    'Bất động sản',
    'Tài chính ngân hàng',
    'Doanh nghiệp',
    'Tài chính quốc tế',
    'Vĩ mô đầu tư',
    'Thị trường',
    'Xã hội',
  ],
  Vietstock: ['Chứng khoán', 'Doanh nghiệp', 'Bất động sản', 'Tài chính', 'Hàng hóa', 'Kinh tế', 'Thế giới'],
  Vnexpress: [
    'Thời sự',
    'Thế giới',
    'Kinh doanh',
    'Khoa học công nghệ',
    'Bất động sản',
    'Giải trí',
    'Đời sống',
    'Pháp luật',
    'Du lịch',
    'Sức khỏe',
    'Thể thao',
  ],
};

const FRESH_WINDOW_MS = 60 * 60 * 1000;

function isFresh(generatedAt: string): boolean {
  const time = new Date(generatedAt).getTime();
  return Number.isFinite(time) && Date.now() - time < FRESH_WINDOW_MS;
}

function categoryTabClassName(group: DigestGroup, isActive: boolean): string {
  return ['category-tab', isActive && 'active', isFresh(group.generatedAt) && 'fresh'].filter(Boolean).join(' ');
}

function sortByCategoryOrder(source: string, categories: DigestGroup[]): DigestGroup[] {
  const order = CATEGORY_ORDER[source] ?? [];
  return [...categories].sort((a, b) => {
    const rankA = order.indexOf(a.category);
    const rankB = order.indexOf(b.category);
    if (rankA === -1 && rankB === -1) return 0;
    if (rankA === -1) return 1;
    if (rankB === -1) return -1;
    return rankA - rankB;
  });
}

function groupBySource(groups: DigestGroup[]): { source: string; categories: DigestGroup[] }[] {
  const bySource = new Map<string, DigestGroup[]>();
  for (const group of groups) {
    const existing = bySource.get(group.source) ?? [];
    existing.push(group);
    bySource.set(group.source, existing);
  }

  const knownAndPresent = KNOWN_SOURCES.map((source) => ({
    source,
    categories: sortByCategoryOrder(source, bySource.get(source) ?? []),
  }));
  const unknownExtras = [...bySource.keys()]
    .filter((source) => !KNOWN_SOURCES.includes(source))
    .map((source) => ({ source, categories: bySource.get(source) ?? [] }));

  return [...knownAndPresent, ...unknownExtras];
}

export default function NewsExplorer({ digest }: { digest: Digest }) {
  const sources = groupBySource(digest.groups);
  const [activeSource, setActiveSource] = useState(sources[0]?.source ?? '');
  const [activeCategory, setActiveCategory] = useState(sources[0]?.categories[0]?.category ?? '');

  const currentSource = sources.find((s) => s.source === activeSource) ?? sources[0];
  const currentCategory = currentSource.categories.find((c) => c.category === activeCategory) ?? currentSource.categories[0];

  function selectSource(source: string) {
    setActiveSource(source);
    const firstCategory = sources.find((s) => s.source === source)?.categories[0]?.category ?? '';
    setActiveCategory(firstCategory);
  }

  return (
    <div>
      <div className="source-tabs-row">
        <div className="source-tabs">
          {sources.map(({ source }) => (
            <button
              key={source}
              className={source === currentSource.source ? 'source-tab active' : 'source-tab'}
              onClick={() => selectSource(source)}
            >
              {source}
            </button>
          ))}
        </div>

        <TriggerDigestButton
          key={currentSource.source}
          source={currentSource.source}
          categories={CATEGORY_ORDER[currentSource.source] ?? currentSource.categories.map((group) => group.category)}
          currentGeneratedAt={digest.generatedAt}
        />
      </div>

      {currentSource.categories.length === 0 ? (
        <div className="empty-state">Chưa có dữ liệu cho {currentSource.source}. Đợi lần chạy tự động tiếp theo.</div>
      ) : (
        <>
          <div className="category-tabs">
            {currentSource.categories.map((group) => (
              <button
                key={group.category}
                className={categoryTabClassName(group, group.category === currentCategory.category)}
                onClick={() => setActiveCategory(group.category)}
              >
                {group.category}
                <span className="category-tab-count">{group.items.length}</span>
              </button>
            ))}
          </div>

          <h2 className="category-heading">{currentCategory.category}</h2>

          <div className="news-list">
            {currentCategory.items.map((item) => {
              const { prTag: summaryPrTag, summary } = splitPrTag(item.summary);
              // Qwen is only instructed to prefix the *summary* with the PR tag, but
              // occasionally carries it over onto the rewritten display title too -
              // strip it from there as well so it never renders as plain (black)
              // title text instead of the bordeaux badge.
              const { prTag: titlePrTag, summary: displayTitle } = splitPrTag(item.displayTitle || item.title);
              const prTag = summaryPrTag || titlePrTag;
              return (
                <article className="news-card" key={item.link}>
                  <span className="timestamp">{formatTimestamp(item.publishedAt)}</span>
                  {item.usedFallback && (
                    <span className="fallback-note">⚠ Tóm tắt tự động (Qwen lỗi, chưa qua AI)</span>
                  )}
                  <h4>
                    {prTag && <span className="pr-tag">{prTag}</span>}
                    <a href={item.link} target="_blank" rel="noreferrer" title={item.displayTitle ? item.title : undefined}>
                      {displayTitle}
                    </a>
                  </h4>
                  <p>{summary}</p>
                  <a className="read-more" href={item.link} target="_blank" rel="noreferrer">
                    Đọc bài gốc →
                  </a>
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
