import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchemeCreatedEvent,
  buildRoundEvent,
  buildLiquidChangeEvent,
  buildRemovalEvent,
  buildRoundCorrectionEvent,
  DomainError,
} from '../src/domain/events.js';
import { replayScheme, replayWithCorrections, deriveTank } from '../src/domain/replay.js';
import { createRecordStore, ConflictError } from '../src/store/recordStore.js';

const AT = '2026-01-01T00:00:00.000Z';

let idCounter;
function genId() {
  return `id-${(idCounter += 1)}`;
}

function makeCreated({ limit = 100, requiredRounds = 2, artifacts = ['甲', '乙'] } = {}) {
  idCounter = 0;
  const event = buildSchemeCreatedEvent({
    name: '补正方案',
    tanks: [{
      name: '1号槽',
      limit,
      requiredRounds,
      artifacts: artifacts.map((name) => ({ name })),
    }],
  }, genId);
  return { ...event, seq: 1, at: AT };
}

function derive(events, tankIndex = 0) {
  return deriveTank(replayScheme(events).tanks[tankIndex]);
}

/** 为当前在泡器物按顺序构造一轮读数。 */
function round(tank, values, startTs) {
  const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
  const readings = soaking.map((a, i) => ({ artifactId: a.id, value: values[i], ts: startTs + i * 1000 }));
  return buildRoundEvent(tank, readings);
}

/** 建案 + 逐轮追加，返回事件数组（每条带 seq/at）。 */
function buildHistory(created, steps) {
  const events = [created];
  for (const step of steps) {
    const tank = derive(events);
    let event;
    if (step.type === 'round') event = round(tank, step.values, step.ts);
    else if (step.type === 'liquid') event = buildLiquidChangeEvent(tank);
    else if (step.type === 'remove') event = buildRemovalEvent(tank, tank.artifacts[step.artifactIndex].id);
    events.push({ ...event, seq: events.length + 1, at: AT });
  }
  return events
}

/** 按器物顺序构造位置对齐的替代读数。 */
function replacementsFor(events, targetSeq, values) {
  const target = events.find((e) => e.seq === targetSeq);
  return target.readings.map((r, i) => ({ artifactId: r.artifactId, value: values[i] }));
}

test('补正成功：替代读数按原轮位置叠入，趋势与资格以补正后重放为准，原读数仍保留', () => {
  const created = makeCreated();
  // r1: 300→280；r2: 100→90（两件均连续 2 轮严格下降且末值达标）
  const events = buildHistory(created, [
    { type: 'round', values: [300, 280], ts: 1_000 },
    { type: 'round', values: [100, 90], ts: 10_000 },
  ]);
  // 把 r1 的甲 300 补正为 310（仍严格下降 310>100），乙 280 补正为 280 不变
  const correction = buildRoundCorrectionEvent(events, 2, replacementsFor(events, 2, [310, 280]));
  assert.equal(correction.type, 'round-corrected');
  assert.equal(correction.targetSeq, 2);
  events.push({ ...correction, seq: events.length + 1, at: AT });

  const tank = derive(events);
  assert.deepEqual(tank.artifacts[0].periodReadings.map((r) => r.value), [310, 100]);
  assert.deepEqual(tank.artifacts[1].periodReadings.map((r) => r.value), [280, 90]);
  // 补正后仍连续下降且末值达标 → 资格不变
  assert.equal(tank.allSoakingEligible, true);

  // 原轮记录未被改写
  const original = events.find((e) => e.seq === 2);
  assert.deepEqual(original.readings.map((r) => r.value), [300, 280]);
  // 重放状态保留原值与补正标记
  const replayedRound = tank.rounds.find((r) => r.seq === 2);
  assert.equal(replayedRound.corrected, true);
  assert.deepEqual(replayedRound.originalReadings.map((r) => r.value), [300, 280]);
  assert.equal(tank.artifacts[0].periodReadings[0].originalValue, 300);
  // 采样时刻完全保持不变
  assert.deepEqual(correction.readings.map((r) => r.ts), original.readings.map((r) => r.ts));
  // 器物集合完全保持不变
  assert.deepEqual(correction.readings.map((r) => r.artifactId), original.readings.map((r) => r.artifactId));
});

test('补正可改变当前资格：末值被补高后整槽失去换液资格', () => {
  const created = makeCreated();
  const events = buildHistory(created, [
    { type: 'round', values: [200, 190], ts: 1_000 },
    { type: 'round', values: [100, 90], ts: 10_000 },
  ]);
  assert.equal(derive(events).allSoakingEligible, true);
  // 把最新一轮乙的 90 补正为 150（高于上限 100），甲补为 100 不变
  const correction = buildRoundCorrectionEvent(events, 3, replacementsFor(events, 3, [100, 150]));
  events.push({ ...correction, seq: events.length + 1, at: AT });
  const tank = derive(events);
  assert.equal(tank.artifacts[0].eligible, true);
  assert.equal(tank.artifacts[1].eligible, false);
  assert.equal(tank.allSoakingEligible, false);
  assert.throws(() => buildLiquidChangeEvent(tank), DomainError);
});

test('补正可恢复资格：把抄高的末值补回上限以下后可换液', () => {
  const created = makeCreated();
  const events = buildHistory(created, [
    { type: 'round', values: [200, 190], ts: 1_000 },
    { type: 'round', values: [100, 150], ts: 10_000 }, // 乙末值 150 被抄错（应 90）
  ]);
  assert.equal(derive(events).allSoakingEligible, false);
  const correction = buildRoundCorrectionEvent(events, 3, replacementsFor(events, 3, [100, 90]));
  events.push({ ...correction, seq: events.length + 1, at: AT });
  assert.equal(derive(events).allSoakingEligible, true);
});

test('补正推翻已执行换液：拒绝写入并返回最早受影响事件（换液记录）', () => {
  const created = makeCreated();
  const events = buildHistory(created, [
    { type: 'round', values: [200, 190], ts: 1_000 },
    { type: 'round', values: [100, 90], ts: 10_000 },
    { type: 'liquid' }, // seq 4：共同达标后换液
  ]);
  // 把 r2 乙补为 150（高于上限），换液 #4 随即失去依据
  const result = replayWithCorrections(events, [{
    targetSeq: 3,
    replacements: replacementsFor(events, 3, [100, 150]),
  }]);
  assert.equal(result.ok, false);
  assert.equal(result.error.seq, 4);
  assert.match(result.error.message, /换液/);
  assert.match(result.error.message, /高于上限/);
  assert.throws(
    () => buildRoundCorrectionEvent(events, 3, replacementsFor(events, 3, [100, 150])),
    (err) => err instanceof DomainError && /#4/.test(err.errors[0]) && /换液/.test(err.errors[0]),
  );
});

test('补正推翻已执行出槽：拒绝写入并指出该器物出槽记录', () => {
  const created = makeCreated({ requiredRounds: 2 });
  const events = buildHistory(created, [
    { type: 'round', values: [200, 190], ts: 1_000 },
    { type: 'round', values: [100, 90], ts: 10_000 },
    { type: 'remove', artifactIndex: 0 }, // seq 4：甲达标出槽
  ]);
  // 把 r2 甲补为 120（回升：200→100? 实际 200→120 仍下降；乙190→90。甲 200→120 连续 2 轮但末值 120 > 100）
  const result = replayWithCorrections(events, [{
    targetSeq: 3,
    replacements: replacementsFor(events, 3, [120, 90]),
  }]);
  assert.equal(result.ok, false);
  assert.equal(result.error.seq, 4);
  assert.match(result.error.message, /出槽/);
  assert.match(result.error.message, /甲/);
});

test('最早受影响事件：换液（#4）先于其后的出槽（#5）失去依据时返回 #4', () => {
  const created = makeCreated({ requiredRounds: 2 });
  const events = buildHistory(created, [
    { type: 'round', values: [200, 190], ts: 1_000 },
    { type: 'round', values: [100, 90], ts: 10_000 },
    { type: 'liquid' }, // #4
    { type: 'round', values: [80, 70], ts: 20_000 }, // #5 新周期
    { type: 'round', values: [60, 50], ts: 30_000 }, // #6
    { type: 'remove', artifactIndex: 0 }, // #7
  ]);
  // 补正旧周期 r2，使 #4 换液与（若继续重放）更多动作失效；最早受影响应为 #4
  const result = replayWithCorrections(events, [{
    targetSeq: 3,
    replacements: replacementsFor(events, 3, [100, 150]),
  }]);
  assert.equal(result.ok, false);
  assert.equal(result.error.seq, 4);
});

test('打断连续下降的补正使其后换液失去依据', () => {
  const created = makeCreated({ requiredRounds: 3 });
  const events = buildHistory(created, [
    { type: 'round', values: [300, 280], ts: 1_000 },
    { type: 'round', values: [200, 190], ts: 10_000 },
    { type: 'round', values: [100, 90], ts: 20_000 },
    { type: 'liquid' }, // #5
  ]);
  // r1 乙 280 补为 150：乙序列 150→190 回升，#5 时乙连续仅 2 轮
  const result = replayWithCorrections(events, [{
    targetSeq: 2,
    replacements: replacementsFor(events, 2, [300, 150]),
  }]);
  assert.equal(result.ok, false);
  assert.equal(result.error.seq, 5);
  assert.match(result.error.message, /连续 2\/3/);
});

test('同一原轮至多一条有效补正：已补正后再次补正被拒绝', () => {
  const created = makeCreated();
  const events = buildHistory(created, [
    { type: 'round', values: [200, 190], ts: 1_000 },
    { type: 'round', values: [100, 90], ts: 10_000 },
  ]);
  const first = buildRoundCorrectionEvent(events, 2, replacementsFor(events, 2, [201, 190]));
  events.push({ ...first, seq: events.length + 1, at: AT });
  assert.throws(
    () => buildRoundCorrectionEvent(events, 2, replacementsFor(events, 2, [202, 190])),
    (err) => err instanceof DomainError && /至多|已存在/.test(err.errors[0]),
  );
});

test('补正结构校验：器物集合、顺序、读数类型均不得改变', () => {
  const created = makeCreated();
  const events = buildHistory(created, [
    { type: 'round', values: [200, 190], ts: 1_000 },
  ]);
  const target = events.find((e) => e.seq === 2);
  const [a, b] = [target.readings[0].artifactId, target.readings[1].artifactId];

  // 缺少一件
  assert.throws(
    () => buildRoundCorrectionEvent(events, 2, [{ artifactId: a, value: 1 }]),
    (err) => /位置|器物集合/.test(err.errors[0]),
  );
  // 多给一件
  assert.throws(
    () => buildRoundCorrectionEvent(events, 2, [
      { artifactId: a, value: 1 }, { artifactId: b, value: 2 }, { artifactId: b, value: 3 },
    ]),
    DomainError,
  );
  // 器物顺序被调换
  assert.throws(
    () => buildRoundCorrectionEvent(events, 2, [
      { artifactId: b, value: 1 }, { artifactId: a, value: 2 },
    ]),
    (err) => /位置|器物集合/.test(err.errors[0]),
  );
  // 非整数 / 负数
  assert.throws(
    () => buildRoundCorrectionEvent(events, 2, [{ artifactId: a, value: 1.5 }, { artifactId: b, value: 2 }]),
    DomainError,
  );
  assert.throws(
    () => buildRoundCorrectionEvent(events, 2, [{ artifactId: a, value: -1 }, { artifactId: b, value: 2 }]),
    DomainError,
  );
  // 0 是合法读数
  assert.ok(buildRoundCorrectionEvent(events, 2, replacementsFor(events, 2, [0, 0])));
});

test('补正目标必须是已提交的某一轮读数', () => {
  const created = makeCreated();
  const events = buildHistory(created, [
    { type: 'round', values: [200, 190], ts: 1_000 },
    { type: 'round', values: [100, 90], ts: 10_000 },
    { type: 'liquid' },
  ]);
  assert.throws(() => buildRoundCorrectionEvent(events, 4, replacementsFor(events, 2, [1, 2])), /目标不存在/);
  assert.throws(() => buildRoundCorrectionEvent(events, 99, []), /目标不存在/);
});

test('补正只影响对应槽位与周期：换液前旧周期的补正不改变新周期累计', () => {
  const created = makeCreated({ requiredRounds: 2 });
  const events = buildHistory(created, [
    { type: 'round', values: [200, 190], ts: 1_000 },
    { type: 'round', values: [100, 90], ts: 10_000 },
    { type: 'liquid' }, // #4
    { type: 'round', values: [80, 70], ts: 20_000 }, // #5
  ]);
  // 旧周期 r1 补正（200→201），换液 #4 仍成立；新周期轮次不受影响
  const correction = buildRoundCorrectionEvent(events, 2, replacementsFor(events, 2, [201, 190]));
  events.push({ ...correction, seq: events.length + 1, at: AT });
  const tank = derive(events);
  assert.equal(tank.liquidChanges, 1);
  assert.equal(tank.nextRoundInPeriod, 2);
  assert.deepEqual(tank.artifacts[0].periodReadings.map((r) => r.value), [80]);
  // 历史读数（含补正后值）仍完整保留
  assert.equal(tank.artifacts[0].readings.length, 3);
  assert.deepEqual(tank.artifacts[0].readings.map((r) => r.value), [201, 100, 80]);
});

test('补正经存储追加：修订号递增；陈旧修订号的补正不得写入', () => {
  idCounter = 0;
  const created = buildSchemeCreatedEvent({
    name: '存储补正',
    tanks: [{ name: '槽', limit: 100, requiredRounds: 2, artifacts: [{ name: '甲' }, { name: '乙' }] }],
  }, genId);
  const kv = (() => {
    const map = new Map();
    return { get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => map.set(k, v) };
  })();
  const store = createRecordStore(kv, { now: () => AT });
  let record = store.create(created.schemeId, created);
  const tankId = created.tanks[0].id;
  const ids = created.tanks[0].artifacts.map((a) => a.id);
  const push = (event) => {
    record = store.append(record.id, event, record.revision);
  };
  push(buildRoundEvent(deriveTank(replayScheme(store.load(record.id).events).tanks[0]), [
    { artifactId: ids[0], value: 200, ts: 1_000 },
    { artifactId: ids[1], value: 190, ts: 2_000 },
  ]));
  push(buildRoundEvent(deriveTank(replayScheme(store.load(record.id).events).tanks[0]), [
    { artifactId: ids[0], value: 100, ts: 10_000 },
    { artifactId: ids[1], value: 90, ts: 11_000 },
  ]));
  const before = record;
  const correction = buildRoundCorrectionEvent(before.events, 2, [
    { artifactId: ids[0], value: 201 },
    { artifactId: ids[1], value: 190 },
  ]);
  assert.equal(correction.tankId, tankId);
  const updated = store.append(before.id, correction, before.revision);
  assert.equal(updated.revision, before.revision + 1);
  assert.equal(updated.events.at(-1).type, 'round-corrected');
  // 用陈旧修订号再补正同一轮 → ConflictError，记录不变
  const stale = buildRoundCorrectionEvent(updated.events, 3, [
    { artifactId: ids[0], value: 101 },
    { artifactId: ids[1], value: 90 },
  ]);
  assert.throws(() => store.append(before.id, stale, before.revision), ConflictError);
  const after = store.load(before.id);
  assert.equal(after.revision, updated.revision);
  assert.equal(after.events.length, updated.events.length);
});

test('重放确定性：含补正的日志直接重放与空挂起重放结果一致', () => {
  const created = makeCreated();
  const events = buildHistory(created, [
    { type: 'round', values: [200, 190], ts: 1_000 },
    { type: 'round', values: [100, 90], ts: 10_000 },
  ]);
  const correction = buildRoundCorrectionEvent(events, 2, replacementsFor(events, 2, [201, 191]));
  events.push({ ...correction, seq: events.length + 1, at: AT });
  assert.deepEqual(replayScheme(events), replayWithCorrections(events, []).state);
});
