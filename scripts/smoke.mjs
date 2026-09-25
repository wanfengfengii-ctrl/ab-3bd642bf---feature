/**
 * 业务模块冒烟：以真实领域模块 + 记录存储跑通完整业务流程。
 * 覆盖：建案 → 逐轮读数 → 资格判定 → 换液清零 → 出槽 → 陈旧修订号拒绝 → 重开还原
 *       → 追溯补正（叠入重放、推翻已执行换液/出槽则拒绝、同轮唯一、重开一致还原）。
 * 任何断言失败都会以非零退出码结束。
 */
import assert from 'node:assert/strict';
import { createRecordStore, ConflictError } from '../src/store/recordStore.js';
import {
  buildSchemeCreatedEvent,
  buildRoundEvent,
  buildLiquidChangeEvent,
  buildRemovalEvent,
  buildRoundCorrectionEvent,
  DomainError,
} from '../src/domain/events.js';
import { replayScheme, replayWithCorrections, deriveTank } from '../src/domain/replay.js';

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

  // ===== 追溯补正：另建独立方案，覆盖叠入重放的完整业务路径 =====
  const corrected = buildSchemeCreatedEvent({
    name: '补正冒烟方案',
    tanks: [{ name: '补正槽', limit: 100, requiredRounds: 2, artifacts: [{ name: '丁' }, { name: '戊' }] }],
  });
  let cRecord = store.create(corrected.schemeId, corrected);
  const cTank = () => deriveTank(replayScheme(store.load(cRecord.id).events).tanks[0]);
  const cSubmit = (values, startTs) => {
    const tank = cTank();
    const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
    cRecord = store.append(cRecord.id, buildRoundEvent(tank, soaking.map((a, k) => ({
      artifactId: a.id, value: values[k], ts: startTs + k * 1000,
    }))), cRecord.revision);
  };
  const cReplacements = (seq, values) => {
    const target = store.load(cRecord.id).events.find((e) => e.seq === seq);
    return target.readings.map((r, i) => ({ artifactId: r.artifactId, value: values[i] }));
  };

  // 10. 两轮共同达标后换液，再出槽一件——形成已有处置依据
  cSubmit([200, 190], 1_000); // #2
  cSubmit([100, 90], 10_000); // #3
  assert.equal(cTank().allSoakingEligible, true);
  cRecord = store.append(cRecord.id, buildLiquidChangeEvent(cTank()), cRecord.revision); // #4 换液
  cSubmit([80, 70], 20_000); // #5 新周期
  cSubmit([60, 50], 30_000); // #6
  cRecord = store.append(cRecord.id, buildRemovalEvent(cTank(), cTank().artifacts[0].id), cRecord.revision); // #7 丁出槽
  step('补正前置：共同达标换液、新周期累计后丁出槽');

  // 11. 不推翻既有处置的补正允许写入：把 #2 丁 200 补为 201（仍严格下降，换液 #4 依旧成立）
  const revisionBefore = cRecord.revision;
  const safeCorrection = buildRoundCorrectionEvent(store.load(cRecord.id).events, 2, cReplacements(2, [201, 190]));
  assert.deepEqual(safeCorrection.readings.map((r) => r.ts), [1_000, 2_000]); // 采样时刻不变
  assert.deepEqual(
    safeCorrection.readings.map((r) => r.artifactId),
    store.load(cRecord.id).events.find((e) => e.seq === 2).readings.map((r) => r.artifactId),
  ); // 器物集合不变
  cRecord = store.append(cRecord.id, safeCorrection, cRecord.revision); // #8
  assert.equal(cRecord.revision, revisionBefore + 1);
  const afterSafe = cTank();
  assert.equal(afterSafe.liquidChanges, 1);
  assert.deepEqual(afterSafe.artifacts[0].readings.map((r) => r.value), [201, 100, 80, 60]);
  assert.equal(afterSafe.artifacts[0].readings[0].originalValue, 200); // 原读数仍可见
  assert.equal(afterSafe.artifacts[0].status, 'removed'); // 已出槽处置保持
  step('不推翻换液/出槽依据的补正写入成功，原读数保留、趋势与资格按补正后重放');

  // 12. 推翻换液依据的补正被拒绝，并返回最早受影响事件（#4 换液）
  let rejected;
  try {
    buildRoundCorrectionEvent(store.load(cRecord.id).events, 3, cReplacements(3, [100, 150]));
  } catch (err) {
    rejected = err;
  }
  assert.ok(rejected instanceof DomainError);
  assert.match(rejected.errors[0], /#4/);
  assert.match(rejected.errors[0], /换液/);
  assert.equal(store.load(cRecord.id).revision, cRecord.revision); // 未写入
  step('补正使已执行换液失去依据：拒绝写入并指出最早受影响记录 #4');

  // 13. 同一原轮至多一条有效补正：#2 已有补正，再补被拒绝
  assert.throws(
    () => buildRoundCorrectionEvent(store.load(cRecord.id).events, 2, cReplacements(2, [202, 190])),
    (err) => err instanceof DomainError && /至多|已存在/.test(err.errors[0]),
  );
  step('同一原轮的重复补正被拒绝');

  // 14. 仅替换非负整数读数：负数/调换器物顺序被拒绝
  assert.throws(
    () => buildRoundCorrectionEvent(store.load(cRecord.id).events, 5, cReplacements(5, [-1, 70])),
    DomainError,
  );
  const swapped = (() => {
    const target = store.load(cRecord.id).events.find((e) => e.seq === 5);
    return [target.readings[1], target.readings[0]].map((r) => ({ artifactId: r.artifactId, value: r.value }));
  })();
  assert.throws(
    () => buildRoundCorrectionEvent(store.load(cRecord.id).events, 5, swapped),
    DomainError,
  );
  step('补正只能按原轮位置替换非负整数读数，器物集合与顺序不可变');

  // 15. 含补正的方案重开后一致还原（修订号、趋势、资格）
  const cReopenedStore = createRecordStore(kv).load(cRecord.id);
  assert.deepEqual(cReopenedStore, store.load(cRecord.id));
  assert.deepEqual(deriveTank(replayScheme(cReopenedStore.events).tanks[0]), cTank());
  assert.equal(replayWithCorrections(cReopenedStore.events, []).ok, true);
  step(`补正方案重开后一致还原（修订号 r${cReopenedStore.revision}）`);

  console.log(`\n冒烟通过：${steps.length} 项业务检查全部符合预期`);
}

try {
  main();
} catch (err) {
  console.error(`\n冒烟失败：${err.stack || err}`);
  process.exit(1);
}
