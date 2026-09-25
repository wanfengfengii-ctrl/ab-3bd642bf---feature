/**
 * 浏览器端存储：localStorage 后端 + 方案索引 + 跨标签页写入串行化。
 * 多标签页同时写入时，先经 Web Locks（可用时）串行化，再由修订号检查兜底，
 * 保证陈旧操作不得写入。
 */
import { createRecordStore } from './recordStore.js';

const INDEX_KEY = 'desalt:index';

export function createBrowserStore(localStorage) {
  const kv = {
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
  };
  const inner = createRecordStore(kv);

  const readIndex = () => {
    try {
      return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
    } catch {
      return [];
    }
  };
  const writeIndex = (list) => localStorage.setItem(INDEX_KEY, JSON.stringify(list));

  async function withLock(id, fn) {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request(`desalt-lock-${id}`, fn);
    }
    return fn();
  }

  return {
    /** 方案列表（含实时修订号）。 */
    listSchemes() {
      return readIndex()
        .map((entry) => {
          const record = inner.load(entry.id);
          return record ? { ...entry, revision: record.revision } : null;
        })
        .filter(Boolean);
    },

    load(id) {
      return inner.load(id);
    },

    async createScheme(schemeCreatedEvent) {
      const id = schemeCreatedEvent.schemeId;
      return withLock(id, () => {
        const record = inner.create(id, schemeCreatedEvent);
        writeIndex([...readIndex(), {
          id,
          name: record.events[0].name,
          createdAt: record.events[0].at,
        }]);
        return record;
      });
    },

    /** 以所见修订号提交事件；修订号不一致时抛 ConflictError。 */
    async append(id, event, baseRevision) {
      return withLock(id, () => inner.append(id, event, baseRevision));
    },
  };
}
