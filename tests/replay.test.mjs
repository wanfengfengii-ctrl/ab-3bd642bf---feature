import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchemeCreatedEvent,
  buildRoundEvent,
  buildLiquidChangeEvent,
  buildRemovalEvent,
  DomainError,
} from '../src/domain/events.js';
import { replayScheme, deriveTank, trailingDecreaseStreak } from '../src/domain/replay.js';

const AT = '2026-01-01T00:00:00.000Z';

function makeCreated() {
  let n = 0;
  const genId = () => `id-${(n += 1)}`;
  const event = buildSchemeCreatedEvent({
    name: '测试方案',
    tanks: [{
      name: '1号槽',
      limit: 100,
      requiredRounds: 3,
      artifacts: [{ name: '甲' }, { name: '乙' }],
    }],
  }, genId);
  return { ...event, seq: 1, at: AT };
}

function append(events, event) {
  events.push({ ...event, seq: events.length + 1, at: AT });
  return events;
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

test('trailingDecreaseStreak 计算末尾连续严格下降轮数', () => {
  assert.equal(trailingDecreaseStreak([]), 0);
  assert.equal(trailingDecreaseStreak([5]), 1);
  assert.equal(trailingDecreaseStreak([5, 4, 3]), 3);
  assert.equal(trailingDecreaseStreak([5, 6, 4]), 2);
  assert.equal(trailingDecreaseStreak([9, 5, 5, 4]), 2);
  assert.equal(trailingDecreaseStreak([100, 105, 95, 90]), 3);
});

test('建立方案后重放：器物在泡、无读数、无资格', () => {
  const tank = derive([makeCreated()]);
  assert.equal(tank.soakingCount, 2);
  assert.equal(tank.liquidChanges, 0);
  assert.equal(tank.nextRoundInPeriod, 1);
  assert.equal(tank.allSoakingEligible, false);
  for (const a of tank.artifacts) {
    assert.equal(a.status, 'soaking');
    assert.equal(a.streak, 0);
    assert.equal(a.eligible, false);
  }
});

test('连续轮数不足时不可换液、不可出槽', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  append(events, round(derive(events), [200, 190], 10_000));
  const tank = derive(events);
  assert.deepEqual(tank.artifacts.map((a) => a.streak), [2, 2]);
  assert.equal(tank.allSoakingEligible, false);
  assert.throws(() => buildLiquidChangeEvent(tank), DomainError);
  assert.throws(() => buildRemovalEvent(tank, tank.artifacts[0].id), DomainError);
});

test('连续 3 轮严格下降且末值不高于上限：整槽可换液、单件可出槽', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  append(events, round(derive(events), [200, 190], 10_000));
  append(events, round(derive(events), [90, 80], 20_000));
  const tank = derive(events);
  assert.deepEqual(tank.artifacts.map((a) => a.streak), [3, 3]);
  assert.equal(tank.allSoakingEligible, true);
  assert.ok(buildLiquidChangeEvent(tank));
  assert.ok(buildRemovalEvent(tank, tank.artifacts[0].id));
});

test('单件短暂下降不能使整槽合格', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  append(events, round(derive(events), [200, 190], 10_000));
  append(events, round(derive(events), [90, 500], 20_000)); // 乙末值上升
  const tank = derive(events);
  assert.equal(tank.artifacts[0].eligible, true);
  assert.equal(tank.artifacts[1].eligible, false);
  assert.equal(tank.allSoakingEligible, false);
  assert.throws(() => buildLiquidChangeEvent(tank), DomainError);
});

test('中间出现回升会打断连续轮数', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [80, 80], 1_000));
  append(events, round(derive(events), [90, 90], 10_000)); // 回升
  append(events, round(derive(events), [85, 85], 20_000));
  const tank = derive(events);
  assert.deepEqual(tank.artifacts.map((a) => a.streak), [2, 2]);
  assert.equal(tank.allSoakingEligible, false);
});

test('末值高于上限即使连续下降也不达标', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 300], 1_000));
  append(events, round(derive(events), [200, 200], 10_000));
  append(events, round(derive(events), [150, 150], 20_000)); // 150 > 上限 100
  const tank = derive(events);
  assert.deepEqual(tank.artifacts.map((a) => a.streak), [3, 3]);
  assert.equal(tank.allSoakingEligible, false);
});

test('换液清空该槽轮次，历史读数保留', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  append(events, round(derive(events), [200, 190], 10_000));
  append(events, round(derive(events), [90, 80], 20_000));
  append(events, buildLiquidChangeEvent(derive(events)));
  const tank = derive(events);
  assert.equal(tank.liquidChanges, 1);
  assert.equal(tank.periodRounds.length, 0);
  assert.equal(tank.nextRoundInPeriod, 1);
  assert.deepEqual(tank.artifacts.map((a) => a.streak), [0, 0]);
  assert.equal(tank.allSoakingEligible, false);
  // 历史不可改写：全部读数仍在重放状态中
  assert.equal(tank.artifacts[0].readings.length, 3);
  // 新周期重新累计
  append(events, round(derive(events), [400, 390], 30_000));
  assert.equal(derive(events).artifacts[0].streak, 1);
});

test('出槽后不再接受该器物读数，后续轮次只覆盖仍在浸泡器物', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  append(events, round(derive(events), [200, 190], 10_000));
  append(events, round(derive(events), [90, 80], 20_000));
  const removedId = derive(events).artifacts[0].id;
  append(events, buildRemovalEvent(derive(events), removedId));
  let tank = derive(events);
  assert.equal(tank.artifacts[0].status, 'removed');
  assert.equal(tank.soakingCount, 1);
  // 新一轮只含在泡的乙（乙本周期读数 280→190→80→70，连续 4 轮严格下降）
  append(events, round(derive(events), [70], 30_000));
  tank = derive(events);
  assert.equal(tank.artifacts[1].streak, 4);
  assert.equal(tank.artifacts[0].readings.length, 3); // 甲不再有新读数
  // 重复出槽被拒绝
  assert.throws(() => buildRemovalEvent(tank, removedId), DomainError);
});

test('全部出槽后该槽不再接受读数、不可换液', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  append(events, round(derive(events), [200, 190], 10_000));
  append(events, round(derive(events), [90, 80], 20_000));
  for (const a of derive(events).artifacts) {
    append(events, buildRemovalEvent(derive(events), a.id));
  }
  const tank = derive(events);
  assert.equal(tank.allRemoved, true);
  assert.throws(() => buildRoundEvent(tank, []), DomainError);
  assert.throws(() => buildLiquidChangeEvent(tank), DomainError);
});

test('重放具有确定性：同一事件序列重放结果一致', () => {
  const events = [makeCreated()];
  append(events, round(derive(events), [300, 280], 1_000));
  append(events, round(derive(events), [90, 80], 10_000));
  assert.deepEqual(replayScheme(events), replayScheme(events));
});

test('未知事件类型与悬空引用会抛错', () => {
  assert.throws(() => replayScheme([{ type: 'nope', seq: 1, at: AT }]), /未知事件类型/);
  const events = [makeCreated()];
  assert.throws(
    () => replayScheme([...events, { type: 'liquid-changed', tankId: 'ghost', seq: 2, at: AT }]),
    /不存在的槽位/,
  );
});
