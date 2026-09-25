/**
 * 记录存储：每个方案一份追加式事件日志。
 * - 修订号 = 已写入事件数，每次写入 +1；
 * - 写入必须携带“所见修订号”（baseRevision），不一致则抛 ConflictError，
 *   陈旧操作不得写入；
 * - 只追加、不修改、不删除，保证过程不可改写。
 *
 * kv 为同步字符串键值后端（浏览器传 localStorage 适配器，测试传 Map 适配器）。
 */

export class ConflictError extends Error {
  constructor(record) {
    super('修订号冲突：方案已在其他地方被更新');
    this.name = 'ConflictError';
    this.current = record;
  }
}

export function createRecordStore(kv, {
  now = () => new Date().toISOString(),
  keyPrefix = 'desalt:scheme:',
} = {}) {
  const keyOf = (id) => `${keyPrefix}${id}`;

  function load(id) {
    const raw = kv.get(keyOf(id));
    return raw ? JSON.parse(raw) : null;
  }

  function save(record) {
    kv.set(keyOf(record.id), JSON.stringify(record));
  }

  return {
    load,

    /** 以“建立方案”事件作为首项记录创建方案，初始修订号为 1。 */
    create(id, schemeCreatedEvent) {
      if (load(id)) throw new Error(`方案已存在：${id}`);
      const record = {
        id,
        revision: 1,
        events: [{ ...schemeCreatedEvent, seq: 1, at: now() }],
      };
      save(record);
      return record;
    },

    /**
     * 基于所见修订号追加事件。
     * @throws {ConflictError} baseRevision 与当前修订号不一致时，拒绝写入并携带最新记录。
     */
    append(id, event, baseRevision) {
      const record = load(id);
      if (!record) throw new Error(`方案不存在：${id}`);
      if (record.revision !== baseRevision) throw new ConflictError(record);
      record.events.push({ ...event, seq: record.events.length + 1, at: now() });
      record.revision += 1;
      save(record);
      return record;
    },
  };
}
