import { renderList } from './listView.js';
import { renderDetail } from './detailView.js';

/**
 * 哈希路由：
 *   #/            方案列表 + 建立新方案
 *   #/scheme/:id  方案详情（趋势、资格、修订号、过程记录）
 */
export function createApp({ store, root, toastEl }) {
  let toastTimer = null;

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 5000);
  }

  const ctx = { store, root, toast };

  function route() {
    const hash = window.location.hash || '#/';
    const match = hash.match(/^#\/scheme\/(.+)$/);
    if (match) {
      renderDetail(ctx, decodeURIComponent(match[1]));
    } else {
      renderList(ctx);
    }
  }

  function start() {
    window.addEventListener('hashchange', route);
    // 其他标签页写入后，本页立即刷新为最新状态。
    window.addEventListener('storage', (event) => {
      if (event.key && event.key.startsWith('desalt:')) {
        route();
        toast('检测到其他标签页的更新，已刷新为最新状态');
      }
    });
    route();
  }

  return { start, route };
}
