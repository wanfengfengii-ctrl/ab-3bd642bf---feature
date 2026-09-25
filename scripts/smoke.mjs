/**
 * 业务模块冒烟：以真实领域模块 + 记录存储跑通完整业务流程。
 * 覆盖：建案 → 逐轮读数 → 资格判定 → 换液清零 → 出槽 → 陈旧修订号拒绝 → 重开还原。
 * 任何断言失败都会以非零退出码结束。
 */
import assert from 'node:assert/strict';
import { createRecordStore, ConflictError } from '../src/store/recordStore.js';
import {
  buildSchemeCreatedEvent,
  buildRoundEvent,
  buildLiquidChangeEvent,
  buildRemovalEvent,
  DomainError,
} from '../src/domain/events.js';
import { replayScheme, deriveTank } from '../src/domain/replay.js';

const steps = [];
function step(name) {
  steps.push(name);
  console.log(`  ✓ ${name}`);
}

function makeKv() {
  const map = new Map();
  return { get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => map.set(k, v) };
}

function main() {
  const kv = makeKv();
  const store = createRecordStore(kv);

  // 1. 建立方案：两个槽位，参数不同
  const created = buildSchemeCreatedEvent({
    name: '冒烟方案',
    tanks: [
      { name: '1号槽', limit: 100, requiredRounds: 3, artifacts: [{ name: '甲' }, { name: '乙' }] },
      { name: '2号槽', limit: 50, requiredRounds: 2, artifacts: [{ name: '丙' }] },
    ],
  });
  let record = store.create(created.schemeId, created);
  assert.equal(record.revision, 1);
  step('建立方案（2 槽 / 3 器物），修订号 r1');

  const tankOf = (i) => deriveTank(replayScheme(store.load(record.id).events).tanks[i]);
  const submit = (i, values, startTs) => {
    const tank = tankOf(i);
    const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
    const event = buildRoundEvent(tank, soaking.map((a, k) => ({
      artifactId: a.id, value: values[k], ts: startTs + k * 1000,
    })));
    record = store.append(record.id, event, record.revision);
  };

  // 2. 1 号槽前两轮：连续轮数不足，整槽无资格
  submit(0, [300, 280], 1_000);
  submit(0, [200, 190], 10_000);
  assert.equal(tankOf(0).allSoakingEligible, false);
  assert.throws(() => buildLiquidChangeEvent(tankOf(0)), DomainError);
  step('连续轮数不足：换液被领域规则拒绝');

  // 3. 第三轮：甲达标、乙回升 → 单件下降不能使整槽合格
  submit(0, [90, 400], 20_000);
  assert.equal(tankOf(0).artifacts[0].eligible, true);
  assert.equal(tankOf(0).allSoakingEligible, false);
  step('单件短暂下降不误判整槽合格');

  // 4. 乙重新连续 3 轮下降达标 → 整槽可换液
  submit(0, [85, 300], 30_000);
  submit(0, [80, 200], 40_000);
  submit(0, [75, 90], 50_000);
  assert.equal(tankOf(0).allSoakingEligible, true);
  record = store.append(record.id, buildLiquidChangeEvent(tankOf(0)), record.revision);
  assert.equal(tankOf(0).liquidChanges, 1);
  assert.equal(tankOf(0).nextRoundInPeriod, 1);
  assert.equal(tankOf(0).artifacts[0].streak, 0);
  step('共同达标后换液，该槽轮次清零');

  // 5. 新周期：甲连续下降且末值达标；乙连续下降但末值仍超上限
  submit(0, [500, 480], 60_000);
  submit(0, [450, 460], 70_000);
  assert.equal(tankOf(0).artifacts[0].eligible, false);
  submit(0, [90, 440], 80_000);
  submit(0, [80, 420], 90_000);
  const tankNow = tankOf(0);
  assert.equal(tankNow.artifacts[0].eligible, true);  // 甲：500>450>90>80 连续 4 轮且末值 ≤ 上限
  assert.equal(tankNow.artifacts[1].eligible, false); // 乙：连续 4 轮下降但末值 420 高于上限 100
  step('新周期重新累计：甲达标、乙末值超上限不达标');

  // 6. 甲出槽；此后轮次只覆盖乙，甲不再接受读数
  const jiaId = tankNow.artifacts[0].id;
  record = store.append(record.id, buildRemovalEvent(tankNow, jiaId), record.revision);
  assert.equal(tankOf(0).soakingCount, 1);
  assert.throws(() => buildRoundEvent(tankOf(0), [
    { artifactId: jiaId, value: 1, ts: 100_000 },
    { artifactId: tankOf(0).artifacts[1].id, value: 2, ts: 101_000 },
  ]), DomainError);
  step('甲出槽后不再接受读数');

  // 7. 陈旧修订号：模拟另一标签页已写入后的过期提交
  const staleRevision = record.revision;
  submit(0, [400], 100_000); // 另一“标签页”写入，修订号前进
  assert.throws(
    () => store.append(record.id, { type: 'liquid-changed', tankId: 'whatever' }, staleRevision),
    ConflictError,
  );
  const afterConflict = store.load(record.id);
  assert.equal(afterConflict.revision, record.revision);
  assert.equal(afterConflict.events.length, record.events.length);
  step('陈旧操作不得写入，记录保持不变');

  // 8. 2 号槽独立判定，不受 1 号槽影响
  submit(1, [80], 200_000);
  submit(1, [40], 210_000);
  assert.equal(tankOf(1).allSoakingEligible, true);
  assert.equal(tankOf(0).allSoakingEligible, false);
  step('多槽位资格相互独立');

  // 9. 模拟刷新/重开：新存储实例 + 同一后端，重放还原相同过程与资格
  const reopened = createRecordStore(kv).load(record.id);
  assert.deepEqual(reopened, store.load(record.id));
  const replayed = replayScheme(reopened.events);
  assert.deepEqual(deriveTank(replayed.tanks[0]), tankOf(0));
  assert.deepEqual(deriveTank(replayed.tanks[1]), tankOf(1));
  assert.equal(reopened.events[0].type, 'scheme-created');
  step(`重开后自首项记录重放还原相同状态（修订号 r${reopened.revision}，共 ${reopened.events.length} 条记录）`);

  console.log(`\n冒烟通过：${steps.length} 项业务检查全部符合预期`);
}

try {
  main();
} catch (err) {
  console.error(`\n冒烟失败：${err.stack || err}`);
  process.exit(1);
}
