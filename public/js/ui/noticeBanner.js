// Notice banner (global chrome, mounted once by main.js): server maintenance announcement
// and countdown, with warning style before cutoff and urgent alert style in the last 10 minutes.

import { html, Icon, useTicker } from './components.js';
import { useStore } from '../store.js';
import { useDocClass } from './device.js';
import { t } from '../../../shared/i18n.js';

function formatCountdown(sec) {
  if (sec <= 0) return '00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTargetTime(deadline) {
  try {
    const d = new Date(deadline);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

export function NoticeBanner() {
  const notice = useStore((s) => s.notice);
  const active = !!(notice && notice.active && notice.deadline);
  useTicker(active ? 1000 : 0);
  useDocClass('sp-notice', active);

  if (!active) return null;

  const now = Date.now();
  const remSec = Math.max(0, Math.round((notice.deadline - now) / 1000));
  const inCutoff = remSec <= (notice.cutoffSec || 600);
  const time = formatTargetTime(notice.deadline);
  const remain = formatCountdown(remSec);

  let text;
  if (inCutoff) {
    text = t('服务器将于 {time} 进行停服维护（剩余 {remain}），已停止创建房间与开局，请局内玩家尽快完成！', { time, remain });
  } else {
    text = t('服务器将于 {time} 进行停服维护（剩余 {remain}），请合理安排对局时间', { time, remain });
  }
  if (notice.message) {
    text += ` (${notice.message})`;
  }

  return html`<aside class=${`notice-banner${inCutoff ? ' notice-banner--cutoff' : ''}`} role="alert">
    <div class="notice-banner__track">
      <${Icon} name="warn" />
      <span class="notice-banner__text">${text}</span>
    </div>
  </aside>`;
}
