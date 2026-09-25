/**
 * 事件重放与派生状态：当前状态永远由首项记录开始重放得到，记录不可改写。
 * 本模块不依赖浏览器，可在 Node 中直接测试。
 *
 * 追溯补正（round-corrected）是追加事件，不改写原轮：
 * 重放时把补正读数按原轮位置叠入，当前趋势与资格一律以叠补后的重放结果为准。
 */
import { EVENT_TYPES } from './events.js';
import { validateRound } from './validate.js';

/**
 * 由事件日志重放方案状态；events 为空时返回 null。
 * 日志中已有的 round-corrected 会在重放时自动叠入对应原轮。
 */
export function replayScheme(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const correctionMap = collectCommittedCorrections(events);
  return replay(events, correctionMap, { validate: false }).state;
}

/**
 * 在已有事件日志上叠加拟提交的补正，自首项记录重放并重新校验。
 *
 * @param {Array<object>} events 已追加的事件日志（含 seq）
 * @param {Array<{targetSeq:number, replacements:Array<{artifactId:string, value:number}>}>} pending
 * @returns {{
 *   ok:boolean,
 *   state:object|null,
 *   corrections:Array<{targetSeq:number, tankId:string, values:number[]}>,
 *   error:{seq:number|null, kind:string, message:string}|null,
 * }}
 *   不合法（结构问题或叠补后其后事件失去依据）时 ok=false，error 指向最早受影响事件及原因。
 */
export function replayWithCorrections(events, pending) {
  if (!Array.isArray(events) || events.length === 0) {
    return fail(null, 'structural', '事件日志为空，无法补正');
  }
  const committed = collectCommittedCorrections(events);
  const roundBySeq = new Map();
  for (const e of events) {
    if (e.type === EVENT_TYPES.ROUND_SUBMITTED) roundBySeq.set(e.seq, e);
  }

  const correctionMap = new Map(committed);
  const normalized = [];
  const pendingTargets = new Set();
  for (const p of pending ?? []) {
    const target = roundBySeq.get(p && p.targetSeq);
    if (!target) {
      return fail(p && p.targetSeq, 'structural', '补正目标不存在：只能对已提交的某一轮读数提出补正');
    }
    if (committed.has(target.seq) || pendingTargets.has(target.seq)) {
      return fail(target.seq, 'structural', '该轮已存在有效补正，同一原轮至多有一条有效补正');
    }
    const replacements = Array.isArray(p.replacements) ? p.replacements : null;
    if (!replacements || replacements.length !== target.readings.length) {
      return fail(target.seq, 'structural', '补正必须按原轮位置逐件给出替代读数：器物集合与采样时刻完全保持不变');
    }
    const values = [];
    for (let i = 0; i < target.readings.length; i += 1) {
      const original = target.readings[i];
      const replacement = replacements[i];
      if (
        !replacement
        || replacement.artifactId !== original.artifactId
        || !Number.isInteger(replacement.value)
        || replacement.value < 0
      ) {
        return fail(target.seq, 'structural', '补正只能替换原轮每件器物的非负整数读数，器物集合与顺序不得改变');
      }
      values.push(replacement.value);
    }
    correctionMap.set(target.seq, {
      values,
      sourceSeq: null,
      readings: target.readings.map((r, i) => ({ ...r, value: values[i] })),
    });
    normalized.push({ targetSeq: target.seq, tankId: target.tankId, values });
    pendingTargets.add(target.seq);
  }

  const { state, error } = replay(events, correctionMap, { validate: true });
  if (error) return { ok: false, state: null, corrections: [], error };
  return { ok: true, state, corrections: normalized, error: null };
}

function fail(seq, kind, message) {
  return { ok: false, state: null, corrections: [], error: { seq, kind, message } };
}

/** 已提交的补正：targetSeq -> 叠补信息（同一原轮至多一条，重复以后到者忽略并保持首条）。 */
function collectCommittedCorrections(events) {
  const map = new Map();
  for (const e of events) {
    if (e.type !== EVENT_TYPES.ROUND_CORRECTED || map.has(e.targetSeq)) continue;
    map.set(e.targetSeq, {
      values: e.readings.map((r) => r.value),
      sourceSeq: e.seq,
      readings: e.readings,
    });
  }
  return map;
}

function applyEvent(state, event, correction, validate) {
  switch (event.type) {
    case EVENT_TYPES.SCHEME_CREATED:
      return onCreated(event);
    case EVENT_TYPES.ROUND_SUBMITTED:
      return onRound(state, event, correction, validate);
    case EVENT_TYPES.LIQUID_CHANGED:
      return onLiquidChange(state, event, validate);
    case EVENT_TYPES.ARTIFACT_REMOVED:
      return onRemoval(state, event, validate);
    case EVENT_TYPES.ROUND_CORRECTED:
      // 补正的效力已在其原轮位置叠入，补正事件本身不产生新的槽位动作。
      return state;
    default:
      throw new Error(`未知事件类型：${event && event.type}`);
  }
}

function replay(events, correctionMap, { validate }) {
  let state = null;
  for (const event of events) {
    const correction = event.type === EVENT_TYPES.ROUND_SUBMITTED
      ? (correctionMap.get(event.seq) || null)
      : null;
    if (validate) {
      const reason = verifyEvent(state, event, correction);
      if (reason) return { state: null, error: { seq: event.seq, kind: event.type, message: reason } };
    }
    state = applyEvent(state, event, correction, validate);
  }
  return { state, error: null };
}

/**
 * 叠补重放下重新验证每条既有事件是否仍符合规则；
 * 返回 null 表示通过，否则返回最早受影响事件的原因说明。
 */
function verifyEvent(state, event, correction) {
  if (!state) return null; // 首项建立方案事件
  const tank = state.tanks.find((t) => t.id === event.tankId);
  if (!tank) return `第 #${event.seq} 条记录引用了不存在的槽位`;
  if (event.type === EVENT_TYPES.ROUND_SUBMITTED) {
    const incoming = correction ? correction.readings : event.readings;
    const errors = validateRound(tank, incoming);
    if (errors.length > 0) {
      return `第 #${event.seq} 条记录（第 ${event.period + 1} 周期第 ${event.roundInPeriod} 轮读数）在补正后不再合法：${errors.join('；')}`;
    }
    return null;
  }
  if (event.type === EVENT_TYPES.LIQUID_CHANGED) {
    const derived = deriveTank(tank);
    if (derived.soakingCount === 0) {
      return `第 #${event.seq} 条记录（换液）失去依据：该槽器物均已出槽，无需换液`;
    }
    if (!derived.allSoakingEligible) {
      const blockers = derived.artifacts
        .filter((a) => a.status === 'soaking' && !a.eligible)
        .map((a) => `「${a.name}」连续 ${a.streak}/${derived.requiredRounds} 轮${a.lastValue == null ? '、尚无读数' : a.lastValue > derived.limit ? `、末值 ${a.lastValue} 高于上限 ${derived.limit}` : ''}`)
        .join('；');
      return `第 #${event.seq} 条记录（换液）失去依据：补正后${blockers}，不满足全部在泡器物共同达标`;
    }
    return null;
  }
  if (event.type === EVENT_TYPES.ARTIFACT_REMOVED) {
    const derived = deriveTank(tank);
    const artifact = derived.artifacts.find((a) => a.id === event.artifactId);
    if (!artifact) return `第 #${event.seq} 条记录（出槽）引用了不存在的器物`;
    if (artifact.status !== 'soaking') {
      return `第 #${event.seq} 条记录（出槽）失去依据：器物「${artifact.name}」此前已出槽`;
    }
    if (!artifact.eligible) {
      return `第 #${event.seq} 条记录（出槽）失去依据：补正后器物「${artifact.name}」仅连续 ${artifact.streak}/${derived.requiredRounds} 轮${artifact.lastValue != null && artifact.lastValue > derived.limit ? `、末值 ${artifact.lastValue} 高于上限 ${derived.limit}` : ''}，不满足出槽条件`;
    }
    return null;
  }
  return null;
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

function onRound(state, event, correction) {
  const tank = findTank(state, event.tankId);
  // 补正只替换读数，器物集合、采样时刻、周期与轮次位置完全沿用原轮。
  const effectiveReadings = correction ? correction.readings : event.readings;
  const corrected = correction != null;
  tank.rounds.push({
    seq: event.seq,
    period: event.period,
    roundInPeriod: event.roundInPeriod,
    readings: effectiveReadings,
    corrected,
    correctedBySeq: corrected ? correction.sourceSeq : null,
    originalReadings: corrected ? event.readings : null,
  });
  for (const r of effectiveReadings) {
    const artifact = tank.artifacts.find((a) => a.id === r.artifactId);
    if (!artifact) throw new Error(`事件引用了不存在的器物：${r.artifactId}`);
    const original = corrected ? event.readings.find((x) => x.artifactId === r.artifactId) : null;
    artifact.readings.push({
      value: r.value,
      ts: r.ts,
      seq: event.seq,
      period: event.period,
      roundInPeriod: event.roundInPeriod,
      corrected,
      originalValue: original ? original.value : null,
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
