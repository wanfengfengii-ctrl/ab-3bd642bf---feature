import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordStore, ConflictError } from '../src/store/recordStore.js';
import { buildSchemeCreatedEvent } from '../src/domain/events.js';
import { replayScheme, deriveTank } from '../src/domain/replay.js';

function makeKv() {
  const map = new Map();
  return { get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => map.set(k, v) };
}

function createdEvent() {
  let n = 0;
  return buildSchemeCreatedEvent({
    name: '存储方案',
    tanks: [{ name: '槽', limit: 100, requiredRounds: 2, artifacts: [{ name: '甲' }] }],
  }, () => `id-${(n += 1)}`);
}

test('创建后修订号为 1，首项记录为建立方案', () => {
  const store = createRecordStore(makeKv(), { now: () => 'T' });
  const event = createdEvent();
  const record = store.create(event.schemeId, event);
  assert.equal(record.revision, 1);
  assert.equal(record.events.length, 1);
  assert.equal(record.events[0].seq, 1);
  assert.equal(record.events[0].type, 'scheme-created');
});

test('以所见修订号追加成功，修订号与序号递增', () => {
  const store = createRecordStore(makeKv(), { now: () => 'T' });
  const event = createdEvent();
  store.create(event.schemeId, event);
  const tankId = event.tanks[0].id;
  const updated = store.append(event.schemeId, { type: 'liquid-changed', tankId }, 1);
  assert.equal(updated.revision, 2);
  assert.equal(updated.events[1].seq, 2);
});

test('陈旧操作不得写入：修订号冲突抛 ConflictError 且数据不变', () => {
  const kv = makeKv();
  const store = createRecordStore(kv, { now: () => 'T' });
  const event = createdEvent();
  store.create(event.schemeId, event);
  const tankId = event.tanks[0].id;
  store.append(event.schemeId, { type: 'liquid-changed', tankId }, 1); // r1 -> r2
  assert.throws(
    () => store.append(event.schemeId, { type: 'liquid-changed', tankId }, 1), // 基于过期的 r1
    (err) => {
      assert.ok(err instanceof ConflictError);
      assert.equal(err.current.revision, 2);
      return true;
    },
  );
  const record = store.load(event.schemeId);
  assert.equal(record.revision, 2);
  assert.equal(record.events.length, 2);
});

test('基于最新修订号可继续写入', () => {
  const store = createRecordStore(makeKv(), { now: () => 'T' });
  const event = createdEvent();
  store.create(event.schemeId, event);
  const tankId = event.tanks[0].id;
  store.append(event.schemeId, { type: 'liquid-changed', tankId }, 1);
  const record = store.append(event.schemeId, { type: 'liquid-changed', tankId }, 2);
  assert.equal(record.revision, 3);
});

test('重新打开（新存储实例、同一后端）后还原相同过程与资格', () => {
  const kv = makeKv();
  const event = createdEvent();
  createRecordStore(kv, { now: () => 'T' }).create(event.schemeId, event);
  const tankId = event.tanks[0].id;
  const artifactId = event.tanks[0].artifacts[0].id;
  const store1 = createRecordStore(kv, { now: () => 'T' });
  store1.append(event.schemeId, {
    type: 'round-submitted', tankId, period: 0, roundInPeriod: 1,
    readings: [{ artifactId, value: 90, ts: 1_000 }],
  }, 1);
  store1.append(event.schemeId, {
    type: 'round-submitted', tankId, period: 0, roundInPeriod: 2,
    readings: [{ artifactId, value: 80, ts: 2_000 }],
  }, 2);
  // 模拟刷新/重新打开：全新存储实例读取同一后端
  const store2 = createRecordStore(kv);
  const record = store2.load(event.schemeId);
  assert.equal(record.revision, 3);
  const tank = deriveTank(replayScheme(record.events).tanks[0]);
  assert.equal(tank.artifacts[0].streak, 2);
  assert.equal(tank.artifacts[0].eligible, true);
  assert.equal(tank.allSoakingEligible, true);
});

test('事件只追加不可改写：存储层不提供修改或删除入口', () => {
  const store = createRecordStore(makeKv());
  assert.equal(typeof store.append, 'function');
  assert.equal(store.update, undefined);
  assert.equal(store.remove, undefined);
  assert.equal(store.delete, undefined);
});
