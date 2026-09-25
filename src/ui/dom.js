/** 展示辅助函数。 */

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export function fmtTs(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 格式化为 datetime-local 输入框所需的本地时间串（分钟精度）。 */
export function toLocalInputValue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
