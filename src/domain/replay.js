/**
 * 事件重放与派生状态：当前状态永远由首项记录开始重放得到，记录不可改写。
 * 追溯补正也是追加事件：重放时将替代读数叠入原轮位置，原轮事件本身保持不变。
 * 本模块不依赖浏览器，可在 Node 中直接测试。
 */
import { EVENT_TYPES } from './events.js';

/** 由事件日志重放出方案状态；events 为空时返回 null。 */
export function replayScheme(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  let state = null;
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}

/** 将单条事件应用到重放状态（导出供补正重放验证逐事件推进）。 */
export function applyEvent(state, event) {
  switch (event.type) {
    case EVENT_TYPES.SCHEME_CREATED:
      return onCreated(event);
    case EVENT_TYPES.ROUND_SUBMITTED:
      return onRound(state, event);
    case EVENT_TYPES.LIQUID_CHANGED:
      return onLiquidChange(state, event);
    case EVENT_TYPES.ARTIFACT_REMOVED:
      return onRemoval(state, event);
    case EVENT_TYPES.ROUND_CORRECTED:
      return onRoundCorrected(state, event);
    default:
      throw new Error(`未知事件类型：${event && event.type}`);
  }
}

function onCreated(event) {
  return {
    id: event.schemeId,
    name: event.name,
    tanks: event.tanks.map((tank) => ({
      id: tank.id,
      name: tank.name,
      limit: tank.limit,
      requiredRounds: tank.requiredRounds,
      liquidChanges: 0,
      lastTs: null,
      rounds: [],
      artifacts: tank.artifacts.map((a) => ({
        id: a.id,
        name: a.name,
        status: 'soaking',
        removedSeq: null,
        readings: [],
      })),
    })),
  };
}

function findTank(state, tankId) {
  const tank = state.tanks.find((t) => t.id === tankId);
  if (!tank) throw new Error(`事件引用了不存在的槽位：${tankId}`);
  return tank;
}

function onRound(state, event) {
  const tank = findTank(state, event.tankId);
  tank.rounds.push({
    seq: event.seq,
    period: event.period,
    roundInPeriod: event.roundInPeriod,
    readings: event.readings,
  });
  for (const r of event.readings) {
    const artifact = tank.artifacts.find((a) => a.id === r.artifactId);
    if (!artifact) throw new Error(`事件引用了不存在的器物：${r.artifactId}`);
    artifact.readings.push({
      value: r.value,
      ts: r.ts,
      seq: event.seq,
      period: event.period,
      roundInPeriod: event.roundInPeriod,
    });
    tank.lastTs = tank.lastTs == null ? r.ts : Math.max(tank.lastTs, r.ts);
  }
  return state;
}

function onLiquidChange(state, event) {
  const tank = findTank(state, event.tankId);
  // 换液清空该槽的轮次：进入新周期，连续轮数自下一周期重新累计。
  tank.liquidChanges += 1;
  return state;
}

function onRemoval(state, event) {
  const tank = findTank(state, event.tankId);
  const artifact = tank.artifacts.find((a) => a.id === event.artifactId);
  if (!artifact) throw new Error(`事件引用了不存在的器物：${event.artifactId}`);
  // 完成出槽的器物不再接受读数。
  artifact.status = 'removed';
  artifact.removedSeq = event.seq;
  return state;
}

/**
 * 追溯补正：将替代读数叠入原轮位置。只替换读数数值，
 * 器物集合与采样时刻完全保持原轮不变；原轮事件与补正事件都留在日志中。
 */
function onRoundCorrected(state, event) {
  const tank = findTank(state, event.tankId);
  const round = tank.rounds.find((r) => r.seq === event.correctsSeq);
  if (!round) throw new Error(`补正事件引用了不存在的轮次：${event.correctsSeq}`);
  const valueOf = new Map(event.readings.map((r) => [r.artifactId, r.value]));
  for (const r of round.readings) {
    if (!valueOf.has(r.artifactId)) {
      throw new Error(`补正读数与原轮器物集合不一致：${r.artifactId}`);
    }
  }
  // 以新对象替换，绝不改动原事件中的读数。
  round.readings = round.readings.map((r) => ({ ...r, value: valueOf.get(r.artifactId) }));
  round.correctedBy = event.seq;
  for (const artifact of tank.artifacts) {
    if (!valueOf.has(artifact.id)) continue;
    artifact.readings = artifact.readings.map((r) => (r.seq === event.correctsSeq
      ? { ...r, value: valueOf.get(artifact.id), corrected: true }
      : r));
  }
  return state;
}

/**
 * 末尾连续严格下降轮数（以读数条数计，每条读数对应一轮）。
 * 例如 [1200, 1100, 990] → 3；[100, 120, 110] → 2。
 */
export function trailingDecreaseStreak(values) {
  if (values.length === 0) return 0;
  let streak = 1;
  for (let i = values.length - 1; i > 0; i -= 1) {
    if (values[i] < values[i - 1]) streak += 1;
    else break;
  }
  return streak;
}

/**
 * 由重放出的槽状态派生展示与资格判定所需信息：
 * 本周期轮次、每件器物本周期读数、连续达标轮数、末值、单件资格与整槽资格。
 */
export function deriveTank(tank) {
  const period = tank.liquidChanges;
  const periodRounds = tank.rounds.filter((r) => r.period === period);
  const artifacts = tank.artifacts.map((a) => {
    const periodReadings = a.readings.filter((r) => r.period === period);
    const values = periodReadings.map((r) => r.value);
    const streak = trailingDecreaseStreak(values);
    const lastValue = values.length > 0 ? values[values.length - 1] : null;
    // 单件资格：自上次换液以来连续达到规定轮数、每一步严格下降且末值不高于上限。
    const eligible = a.status === 'soaking'
      && streak >= tank.requiredRounds
      && lastValue != null
      && lastValue <= tank.limit;
    return { ...a, periodReadings, streak, lastValue, eligible };
  });
  const soaking = artifacts.filter((a) => a.status === 'soaking');
  return {
    ...tank,
    artifacts,
    periodRounds,
    soakingCount: soaking.length,
    removedCount: artifacts.length - soaking.length,
    allRemoved: soaking.length === 0,
    // 整槽资格：全部在泡器物共同达标，避免把单件短暂下降误作整槽合格。
    allSoakingEligible: soaking.length > 0 && soaking.every((a) => a.eligible),
    nextRoundInPeriod: periodRounds.length + 1,
  };
}
