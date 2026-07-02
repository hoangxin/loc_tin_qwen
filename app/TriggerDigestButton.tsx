'use client';

import { useState } from 'react';

type Status = 'idle' | 'asking' | 'loading' | 'done' | 'error';

const DEFAULT_HOURS = 24;

export default function TriggerDigestButton({ source, categories }: { source: string; categories: string[] }) {
  const [status, setStatus] = useState<Status>('idle');
  const [hours, setHours] = useState(String(DEFAULT_HOURS));
  const [selected, setSelected] = useState<Set<string>>(new Set(categories));
  const [message, setMessage] = useState('');

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
        `Đã kích hoạt tổng hợp ${source} (${selected.size}/${categories.length} mục) trong ${data.hours}h gần nhất. Chờ khoảng vài phút rồi tải lại trang.`
      );
      setStatus('done');
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
      <button className="trigger-button trigger-button-secondary" onClick={() => setStatus('idle')}>
        Đóng
      </button>
    </div>
  );
}
