import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchemePayload, validateRound } from '../src/domain/validate.js';
import { buildSchemeCreatedEvent, buildRoundEvent } from '../src/domain/events.js';
import { replayScheme, deriveTank } from '../src/domain/replay.js';

const AT = '2026-01-01T00:00:00.000Z';

function makeTank() {
  let n = 0;
  const created = buildSchemeCreatedEvent({
    name: '校验方案',
    tanks: [{
      name: '1号槽',
      limit: 100,
      requiredRounds: 2,
      artifacts: [{ name: '甲' }, { name: '乙' }],
    }],
  }, () => `id-${(n += 1)}`);
  return deriveTank(replayScheme([{ ...created, seq: 1, at: AT }]).tanks[0]);
}

function readingsFor(tank, values, startTs) {
  return tank.artifacts
    .filter((a) => a.status === 'soaking')
    .map((a, i) => ({ artifactId: a.id, value: values[i], ts: startTs + i * 1000 }));
}

test('合法方案通过校验', () => {
  assert.deepEqual(validateSchemePayload({
    name: '方案',
    tanks: [{ name: '槽', limit: 0, requiredRounds: 2, artifacts: [{ name: '甲' }] }],
  }), []);
});

test('方案校验：名称、槽位、上限、轮数、器物逐项拦截', () => {
  assert.ok(validateSchemePayload({ name: ' ', tanks: [{ name: '槽', limit: 1, requiredRounds: 2, artifacts: [{ name: '甲' }] }] })[0].includes('名称'));
  assert.ok(validateSchemePayload({ name: 'x', tanks: [] }).some((e) => e.includes('至少需要一个槽位')));
  assert.ok(validateSchemePayload({ name: 'x', tanks: [{ name: '槽', limit: 1.5, requiredRounds: 2, artifacts: [{ name: '甲' }] }] }).some((e) => e.includes('上限')));
  assert.ok(validateSchemePayload({ name: 'x', tanks: [{ name: '槽', limit: -1, requiredRounds: 2, artifacts: [{ name: '甲' }] }] }).some((e) => e.includes('上限')));
  assert.ok(validateSchemePayload({ name: 'x', tanks: [{ name: '槽', limit: 1, requiredRounds: 1, artifacts: [{ name: '甲' }] }] }).some((e) => e.includes('连续轮数')));
  assert.ok(validateSchemePayload({ name: 'x', tanks: [{ name: '槽', limit: 1, requiredRounds: 2, artifacts: [] }] }).some((e) => e.includes('至少需要一件器物')));
  assert.ok(validateSchemePayload({ name: 'x', tanks: [{ name: '槽', limit: 1, requiredRounds: 2, artifacts: [{ name: ' ' }] }] }).some((e) => e.includes('器物名称')));
});

test('合法一轮读数通过校验', () => {
  const tank = makeTank();
  assert.deepEqual(validateRound(tank, readingsFor(tank, [200, 190], 1_000)), []);
});

test('每轮必须恰含每件在泡器物各一次读数', () => {
  const tank = makeTank();
  const [a, b] = tank.artifacts;
  // 缺少乙
  assert.ok(validateRound(tank, [{ artifactId: a.id, value: 1, ts: 1_000 }]).some((e) => e.includes('缺少器物「乙」')));
  // 甲重复
  assert.ok(validateRound(tank, [
    { artifactId: a.id, value: 1, ts: 1_000 },
    { artifactId: a.id, value: 2, ts: 2_000 },
    { artifactId: b.id, value: 3, ts: 3_000 },
  ]).some((e) => e.includes('只能提交一次')));
  // 包含不存在的器物
  assert.ok(validateRound(tank, [
    { artifactId: a.id, value: 1, ts: 1_000 },
    { artifactId: b.id, value: 2, ts: 2_000 },
    { artifactId: 'ghost', value: 3, ts: 3_000 },
  ]).some((e) => e.includes('已出槽或不属于本槽')));
});

test('读数须为不小于 0 的整数', () => {
  const tank = makeTank();
  const bad = (v) => validateRound(tank, readingsFor(tank, [v, 1], 1_000)).some((e) => e.includes('整数'));
  assert.ok(bad(1.5));
  assert.ok(bad(-1));
  assert.ok(bad(NaN));
  assert.ok(!bad(0));
});

test('同一轮内采样时间必须严格递增', () => {
  const tank = makeTank();
  const [a, b] = tank.artifacts;
  const equal = [
    { artifactId: a.id, value: 1, ts: 1_000 },
    { artifactId: b.id, value: 2, ts: 1_000 },
  ];
  assert.ok(validateRound(tank, equal).some((e) => e.includes('严格递增')));
  const backwards = [
    { artifactId: a.id, value: 1, ts: 2_000 },
    { artifactId: b.id, value: 2, ts: 1_000 },
  ];
  assert.ok(validateRound(tank, backwards).some((e) => e.includes('严格递增')));
});

test('新一轮采样时间必须晚于本槽此前全部读数', () => {
  // 用同一方案写入第一轮（末时间戳 11_000）
  let n = 0;
  const created = buildSchemeCreatedEvent({
    name: 's',
    tanks: [{ name: 't', limit: 100, requiredRounds: 2, artifacts: [{ name: '甲' }, { name: '乙' }] }],
  }, () => `id-${(n += 1)}`);
  const events = [{ ...created, seq: 1, at: AT }];
  const tank1 = deriveTank(replayScheme(events).tanks[0]);
  const first = buildRoundEvent(tank1, readingsFor(tank1, [200, 190], 10_000));
  events.push({ ...first, seq: 2, at: AT });
  const tank2 = deriveTank(replayScheme(events).tanks[0]);
  const stale = tank2.artifacts.map((a, i) => ({ artifactId: a.id, value: 100 - i, ts: 11_000 + i * 1000 }));
  assert.ok(validateRound(tank2, stale).some((e) => e.includes('晚于')));
  const fresh = tank2.artifacts.map((a, i) => ({ artifactId: a.id, value: 100 - i, ts: 11_001 + i * 1000 }));
  assert.deepEqual(validateRound(tank2, fresh), []);
});

test('全部出槽后不再接受读数', () => {
  const tank = makeTank();
  const emptied = { ...tank, artifacts: tank.artifacts.map((a) => ({ ...a, status: 'removed' })) };
  assert.ok(validateRound(emptied, []).some((e) => e.includes('均已出槽')));
});
