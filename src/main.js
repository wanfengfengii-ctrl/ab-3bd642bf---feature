import { createBrowserStore } from './store/browserStore.js';
import { createApp } from './ui/app.js';

function bootstrap() {
  const store = createBrowserStore(window.localStorage);
  const app = createApp({
    store,
    root: document.getElementById('app'),
    toastEl: document.getElementById('toast'),
  });
  app.start();
}

// 仅在浏览器环境启动，便于 Node 构建期对全部模块做加载检查。
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootstrap();
}
