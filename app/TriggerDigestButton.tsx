'use client';

import { useEffect, useRef, useState } from 'react';

type Status = 'idle' | 'asking' | 'loading' | 'waiting' | 'error';

const DEFAULT_HOURS = 24;
const POLL_INTERVAL_MS = 15000;
// GitHub Actions job itself is capped at 15 minutes, plus time for the commit
// to land and Vercel to build - stop polling well past that so a stuck run
// doesn't leave the tab quietly fetching forever.
const MAX_POLL_MS = 20 * 60 * 1000;

export default function TriggerDigestButton({
  source,
  categories,
  currentGeneratedAt,
}: {
  source: string;
  categories: string[];
  currentGeneratedAt: string;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const [hours, setHours] = useState(String(DEFAULT_HOURS));
  const [selected, setSelected] = useState<Set<string>>(new Set(categories));
  const [message, setMessage] = useState('');
  const pollHandle = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollHandle.current) clearInterval(pollHandle.current);
    };
  }, []);

  function stopPolling() {
    if (pollHandle.current) {
      clearInterval(pollHandle.current);
      pollHandle.current = null;
    }
  }

  function startPolling() {
    const startedAt = Date.now();
    pollHandle.current = setInterval(async () => {
      if (Date.now() - startedAt > MAX_POLL_MS) {
        stopPolling();
        setMessage('Chạy lâu hơn dự kiến so với bình thường - bạn tự tải lại trang sau nhé.');
        setStatus('error');
        return;
      }
      try {
        const response = await fetch('/api/digest-meta', { cache: 'no-store' });
        const data = await response.json();
        if (data?.generatedAt && data.generatedAt !== currentGeneratedAt) {
          stopPolling();
          window.location.reload();
        }
      } catch {
        // transient fetch hiccup - keep polling, don't bail on one failed check
      }
    }, POLL_INTERVAL_MS);
  }

  function openForm() {
    setSelected(new Set(categories));
    setHours(String(DEFAULT_HOURS));
    setStatus('asking');
  }

  function toggleCategory(category: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  async function runDigest() {
    const parsedHours = Number(hours);
    if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
      setMessage('Số giờ không hợp lệ.');
      setStatus('error');
      return;
    }
    if (selected.size === 0) {
      setMessage('Chọn ít nhất một mục.');
      setStatus('error');
      return;
    }

    setStatus('loading');
    try {
      const response = await fetch('/api/trigger-digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hours: parsedHours, source, categories: [...selected] }),
      });
      const data = await response.json();

      if (!response.ok) {
        setMessage(data?.error || 'Có lỗi xảy ra.');
        setStatus('error');
        return;
      }

      setMessage(
        `Đã kích hoạt tổng hợp ${source} (${selected.size}/${categories.length} mục) trong ${data.hours}h gần nhất. Trang sẽ tự tải lại khi xong.`
      );
      setStatus('waiting');
      startPolling();
    } catch {
      setMessage('Không kết nối được tới server.');
      setStatus('error');
    }
  }

  if (status === 'idle') {
    return (
      <button className="trigger-button" onClick={openForm}>
        Tổng hợp {source}
      </button>
    );
  }

  if (status === 'asking' || status === 'loading') {
    return (
      <div className="trigger-panel">
        <div className="trigger-categories">
          {categories.map((category) => (
            <label key={category} className="trigger-category">
              <input
                type="checkbox"
                checked={selected.has(category)}
                disabled={status === 'loading'}
                onChange={() => toggleCategory(category)}
              />
              {category}
            </label>
          ))}
        </div>
        <div className="trigger-form">
          <label htmlFor="trigger-hours">Trong</label>
          <input
            id="trigger-hours"
            type="number"
            min={1}
            max={168}
            value={hours}
            disabled={status === 'loading'}
            onChange={(event) => setHours(event.target.value)}
          />
          <span>giờ gần nhất</span>
          <button className="trigger-button" disabled={status === 'loading'} onClick={runDigest}>
            {status === 'loading' ? 'Đang chạy...' : 'Chạy'}
          </button>
          <button
            className="trigger-button trigger-button-secondary"
            disabled={status === 'loading'}
            onClick={() => setStatus('idle')}
          >
            Huỷ
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="trigger-form">
      <span className={status === 'error' ? 'trigger-message trigger-message-error' : 'trigger-message'}>
        {message}
      </span>
      <button
        className="trigger-button trigger-button-secondary"
        onClick={() => {
          stopPolling();
          setStatus('idle');
        }}
      >
        {status === 'waiting' ? 'Huỷ chờ' : 'Đóng'}
      </button>
    </div>
  );
}
