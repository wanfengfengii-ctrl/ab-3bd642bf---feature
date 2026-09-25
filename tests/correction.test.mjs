import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchemeCreatedEvent,
  buildRoundEvent,
  buildLiquidChangeEvent,
  buildRemovalEvent,
  DomainError,
  EVENT_TYPES,
} from '../src/domain/events.js';
import {
  buildRoundCorrectionEvent,
  validateCorrection,
  revalidateEventStream,
  foldCorrections,
} from '../src/domain/correction.js';
import { replayScheme, deriveTank } from '../src/domain/replay.js';
import { createRecordStore, ConflictError } from '../src/store/recordStore.js';

const AT = '2026-01-01T00:00:00.000Z';

function makeCreated(requiredRounds = 2) {
  let n = 0;
  const event = buildSchemeCreatedEvent({
    name: '补正测试方案',
    tanks: [{
      name: '1号槽',
      limit: 100,
      requiredRounds,
      artifacts: [{ name: '甲' }, { name: '乙' }],
    }],
  }, () => `id-${(n += 1)}`);
  return { ...event, seq: 1, at: AT };
}

function append(events, event) {
  events.push({ ...event, seq: events.length + 1, at: AT });
  return events;
}

function derive(events, tankIndex = 0) {
  return deriveTank(replayScheme(events).tanks[tankIndex]);
}

function round(tank, values, startTs) {
  const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
  return buildRoundEvent(tank, soaking.map((a, i) => ({ artifactId: a.id, value: values[i], ts: startTs + i * 1000 })));
}

/** 常见场景：两轮达标后换液（事件 #4），进入新周期又提交一轮（事件 #5）。 */
function scenarioWithLiquidChange() {
  const events = [makeCreated()];
  append(events, round(derive(events), [200, 200], 1_000)); // #2
  append(events, round(derive(events), [90, 90], 10_000));  // #3
  append(events, buildLiquidChangeEvent(derive(events)));   // #4 换液
  append(events, round(derive(events), [50, 50], 20_000));  // #5
  return events;
}

function correctionOf(events, targetSeq, values) {
  const target = events.find((e) => e.seq === targetSeq);
  return buildRoundCorrectionEvent(
    events,
    targetSeq,
    target.readings.map((r, i) => ({ artifactId: r.artifactId, value: values[i] })),
  );
}

test('合法补正：替换读数，器物集合与采样时刻保持不变，原事件不被修改', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000)); // #2
  append(events, round(derive(events), [200, 190], 3_000)); // #3
  append(events, round(derive(events), [90, 80], 5_000));   // #4

  const correction = correctionOf(events, 2, [310, 270]);
  assert.equal(correction.type, EVENT_TYPES.ROUND_CORRECTED);
  assert.equal(correction.correctsSeq, 2);
  append(events, correction); // #5

  const tank = derive(events);
  const [a, b] = tank.artifacts;
  // 当前趋势以补正后重放为准
  assert.deepEqual(a.readings.map((r) => r.value), [310, 200, 90]);
  assert.deepEqual(b.readings.map((r) => r.value), [270, 190, 80]);
  // 采样时刻完全沿用原轮
  assert.deepEqual(a.readings.map((r) => r.ts), [1_000, 3_000, 5_000]);
  assert.deepEqual(b.readings.map((r) => r.ts), [2_000, 4_000, 6_000]);
  // 补正读数带标记，资格一致还原
  assert.equal(a.readings[0].corrected, true);
  assert.equal(a.readings[1].corrected, undefined);
  assert.deepEqual(tank.artifacts.map((x) => x.streak), [3, 3]);
  assert.equal(tank.allSoakingEligible, true);
  // 原轮事件保持原读数，补正作为新事件可见
  assert.deepEqual(events[1].readings.map((r) => r.value), [300, 280]);
  assert.equal(events[4].type, EVENT_TYPES.ROUND_CORRECTED);
  assert.equal(events.length, 5);
});

test('补正读数按原轮器物顺序归一（与提交顺序无关）', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  const target = events[1];
  const correction = buildRoundCorrectionEvent(
    events,
    2,
    [...target.readings].reverse().map((r) => ({ artifactId: r.artifactId, value: 111 })),
  );
  assert.deepEqual(correction.readings.map((r) => r.artifactId), target.readings.map((r) => r.artifactId));
});

test('补正目标必须是一轮已提交的读数', () => {
  const events = scenarioWithLiquidChange();
  assert.ok(validateCorrection(events, 99, []).some((e) => e.includes('不存在或不是一轮')));
  assert.ok(validateCorrection(events, 4, []).some((e) => e.includes('不存在或不是一轮'))); // #4 是换液
  assert.throws(
    () => buildRoundCorrectionEvent(events, 4, [{ artifactId: 'x', value: 1 }]),
    DomainError,
  );
});

test('替代读数须为不小于 0 的整数', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  const [a, b] = events[1].readings;
  const bad = (v) => validateCorrection(events, 2, [
    { artifactId: a.artifactId, value: v },
    { artifactId: b.artifactId, value: 100 },
  ]).some((e) => e.includes('不小于 0 的整数'));
  assert.ok(bad(-1));
  assert.ok(bad(1.5));
  assert.ok(bad(NaN));
  assert.ok(!bad(0));
});

test('器物集合必须与原轮完全一致：不缺、不多、不重复', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  const [a, b] = events[1].readings;
  // 缺少乙
  assert.ok(validateCorrection(events, 2, [{ artifactId: a.artifactId, value: 1 }])
    .some((e) => e.includes('缺少') && e.includes('乙')));
  // 多出原轮之外的器物
  assert.ok(validateCorrection(events, 2, [
    { artifactId: a.artifactId, value: 1 },
    { artifactId: b.artifactId, value: 2 },
    { artifactId: 'ghost', value: 3 },
  ]).some((e) => e.includes('原轮之外')));
  // 甲重复
  assert.ok(validateCorrection(events, 2, [
    { artifactId: a.artifactId, value: 1 },
    { artifactId: a.artifactId, value: 2 },
    { artifactId: b.artifactId, value: 3 },
  ]).some((e) => e.includes('重复')));
});

test('同一原轮至多一条有效补正', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  append(events, correctionOf(events, 2, [310, 270])); // #3 第一次补正成功
  assert.ok(validateCorrection(events, 2, [{ artifactId: 'x', value: 1 }])
    .some((e) => e.includes('至多')));
  assert.throws(() => correctionOf(events, 2, [320, 260]), (err) => {
    assert.ok(err instanceof DomainError);
    assert.ok(err.errors.some((e) => e.includes('至多')));
    return true;
  });
});

test('补正使后续换液失去依据：拒绝并报告最早受影响事件及原因', () => {
  const events = scenarioWithLiquidChange();
  // 把第 2 轮乙的读数改为 500：乙 200→500 不再连续下降，#4 换液失去依据
  assert.throws(() => correctionOf(events, 3, [90, 500]), (err) => {
    assert.ok(err instanceof DomainError);
    assert.ok(err.message.includes('#4'), `应报告最早受影响事件 #4，实际：${err.message}`);
    assert.ok(err.message.includes('换液'), `应说明换液失去依据，实际：${err.message}`);
    return true;
  });
  // 不改变任何既有依据的补正仍可保存（哪怕当前资格发生变化）
  const ok = correctionOf(events, 3, [90, 95]);
  assert.equal(ok.correctsSeq, 3);
});

test('补正使出槽失去依据：拒绝并报告出槽事件', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [200, 200], 1_000)); // #2
  append(events, round(derive(events), [90, 90], 10_000));  // #3
  const jiaId = derive(events).artifacts[0].id;
  append(events, buildRemovalEvent(derive(events), jiaId)); // #4 甲出槽
  // 把甲第 1 轮改为 80：80→90 回升，甲在 #4 出槽时并未连续达标
  assert.throws(() => correctionOf(events, 2, [80, 200]), (err) => {
    assert.ok(err instanceof DomainError);
    assert.ok(err.message.includes('#4'), `应报告最早受影响事件 #4，实际：${err.message}`);
    assert.ok(err.message.includes('出槽'), `应说明出槽失去依据，实际：${err.message}`);
    return true;
  });
});

test('最早受影响事件为时间线上第一条失去依据的记录', () => {
  const events = scenarioWithLiquidChange();
  append(events, round(derive(events), [40, 40], 30_000));  // #6
  append(events, buildLiquidChangeEvent(derive(events)));   // #7 第二次换液（50→40 达标）
  // 直接构造补正事件（绕过构造器），检验重放验证引擎本身
  const target = events.find((e) => e.seq === 3);
  const correction = {
    type: EVENT_TYPES.ROUND_CORRECTED,
    tankId: target.tankId,
    correctsSeq: 3,
    readings: target.readings.map((r, i) => ({ artifactId: r.artifactId, value: [90, 500][i] })),
  };
  const failure = revalidateEventStream([...events, { ...correction, seq: events.length + 1 }]);
  assert.equal(failure.seq, 4);
  assert.ok(failure.reason.includes('换液'));
});

test('补正不影响其他槽位与其他轮的判定', () => {
  let n = 0;
  const created = buildSchemeCreatedEvent({
    name: '多槽方案',
    tanks: [
      { name: '1号槽', limit: 100, requiredRounds: 2, artifacts: [{ name: '甲' }] },
      { name: '2号槽', limit: 50, requiredRounds: 2, artifacts: [{ name: '丙' }] },
    ],
  }, () => `id-${(n += 1)}`);
  const events = [{ ...created, seq: 1, at: AT }];
  append(events, round(derive(events, 0), [200], 1_000)); // #2
  append(events, round(derive(events, 0), [90], 2_000));  // #3
  append(events, round(derive(events, 1), [80], 3_000));  // #4
  append(events, round(derive(events, 1), [40], 4_000));  // #5
  append(events, correctionOf(events, 2, [210]));         // #6 补正 1 号槽第 1 轮
  assert.equal(derive(events, 0).artifacts[0].readings[0].value, 210);
  assert.equal(derive(events, 0).allSoakingEligible, true);
  assert.equal(derive(events, 1).allSoakingEligible, true);
  assert.equal(derive(events, 1).artifacts[0].readings[0].value, 80);
});

test('foldCorrections 叠入补正得到有效流，原事件不被修改', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  append(events, correctionOf(events, 2, [310, 270]));
  const folded = foldCorrections(events);
  assert.equal(folded.events.length, 2); // 补正事件不进入有效流
  assert.deepEqual(folded.events[1].readings.map((r) => r.value), [310, 270]);
  assert.deepEqual(events[1].readings.map((r) => r.value), [300, 280]); // 原事件不变
  // 有效流重放出的读数与资格，同含补正日志的重放结果一致
  const readingsOf = (list) => deriveTank(replayScheme(list).tanks[0]).artifacts
    .map((a) => a.readings.map((r) => [r.value, r.ts]));
  assert.deepEqual(readingsOf(folded.events), readingsOf(events));
  assert.equal(
    deriveTank(replayScheme(folded.events).tanks[0]).allSoakingEligible,
    derive(events).allSoakingEligible,
  );
});

test('revalidateEventStream 对合法日志返回 null，对手工篡改的日志报最早问题', () => {
  const events = scenarioWithLiquidChange();
  assert.equal(revalidateEventStream(events), null);
  // 手工篡改：换液事件移到读数之前（首轮之前换液无依据）
  const tampered = [events[0], events[3], events[1], events[2], events[4]];
  const failure = revalidateEventStream(tampered);
  assert.equal(failure.seq, 4);
});

test('不同原轮可各有至多一条补正，重放时全部叠入', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000)); // #2
  append(events, round(derive(events), [200, 190], 10_000)); // #3
  append(events, correctionOf(events, 2, [310, 270]));       // #4
  append(events, correctionOf(events, 3, [210, 180]));       // #5：另一轮的补正
  const tank = derive(events);
  assert.deepEqual(tank.artifacts[0].readings.map((r) => r.value), [310, 210]);
  assert.deepEqual(tank.artifacts[1].readings.map((r) => r.value), [270, 180]);
  assert.equal(revalidateEventStream(events), null);
  // 原轮事件均保持原值
  assert.deepEqual(events[1].readings.map((r) => r.value), [300, 280]);
  assert.deepEqual(events[2].readings.map((r) => r.value), [200, 190]);
});

test('补正经存储写入：修订号递增、重开还原一致、陈旧修订拒绝', () => {
  const kv = (() => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v) }; })();
  const store = createRecordStore(kv, { now: () => AT });
  const created = makeCreated();
  let record = store.create(created.schemeId, created);
  const submit = (values, startTs) => {
    const tank = deriveTank(replayScheme(store.load(record.id).events).tanks[0]);
    record = store.append(record.id, round(tank, values, startTs), record.revision);
  };
  submit([300, 280], 1_000); // r2
  submit([200, 190], 3_000); // r3

  // 以所见修订号提交补正
  const correction = buildRoundCorrectionEvent(
    record.events,
    2,
    record.events[1].readings.map((r) => ({ artifactId: r.artifactId, value: r.value + 10 })),
  );
  record = store.append(record.id, correction, record.revision); // r4
  assert.equal(record.revision, 4);
  assert.equal(record.events[3].type, EVENT_TYPES.ROUND_CORRECTED);

  // 模拟重开：新存储实例重放还原相同的补正后状态
  const reopened = createRecordStore(kv).load(record.id);
  const tank = deriveTank(replayScheme(reopened.events).tanks[0]);
  assert.deepEqual(tank.artifacts[0].readings.map((r) => r.value), [310, 200]);
  assert.deepEqual(tank.artifacts[1].readings.map((r) => r.value), [290, 190]);

  // 陈旧修订号不得写入
  assert.throws(
    () => store.append(record.id, { ...correction, correctsSeq: 3 }, 3),
    ConflictError,
  );
  assert.equal(store.load(record.id).events.length, 4);
});
