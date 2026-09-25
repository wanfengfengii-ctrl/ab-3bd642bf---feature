/**
 * 追溯补正：修复师发现已提交的一整轮电导率被抄错时，对该轮提出替代读数。
 *
 * 规则：
 * - 补正只替换原轮每件器物的读数（不小于 0 的整数）；
 *   器物集合与采样时刻完全保持原轮不变；
 * - 同一原轮至多有一条有效补正；
 * - 提交时把替代读数按原轮位置叠入，自首项记录重放，
 *   并重新验证其后的每次读数、换液和出槽是否仍符合既有规则；
 *   任一事件失去依据即拒绝写入，并报告最早受影响事件及原因；
 * - 补正本身也是追加事件，原读数与补正都留在不可改写过程中。
 *
 * 本模块不依赖浏览器，可在 Node 中直接测试。
 */
import { EVENT_TYPES, DomainError } from './events.js';
import { applyEvent, deriveTank } from './replay.js';
import { validateRound } from './validate.js';

/**
 * 校验一条补正的结构规则（不涉及重放）：
 * 目标须为已提交的读数轮、尚无有效补正、器物集合完全一致、替代读数为非负整数。
 * 返回错误信息数组（空数组表示通过）。
 */
export function validateCorrection(events, targetSeq, readings) {
  const errors = [];
  const target = Array.isArray(events)
    ? events.find((e) => e.type === EVENT_TYPES.ROUND_SUBMITTED && e.seq === targetSeq)
    : null;
  if (!target) {
    return ['补正目标不存在或不是一轮已提交的读数'];
  }
  if (events.some((e) => e.type === EVENT_TYPES.ROUND_CORRECTED && e.correctsSeq === targetSeq)) {
    errors.push('该轮已存在有效补正，同一原轮至多允许一条补正');
  }
  if (!Array.isArray(readings) || readings.length === 0) {
    errors.push('补正读数为空');
    return errors;
  }

  const nameOf = artifactNamer(events, target);
  const seen = new Set();
  const byId = new Map();
  for (const r of readings) {
    if (seen.has(r.artifactId)) {
      errors.push(`器物「${nameOf(r.artifactId)}」在补正中重复出现`);
      continue;
    }
    seen.add(r.artifactId);
    byId.set(r.artifactId, r.value);
    if (!Number.isInteger(r.value) || r.value < 0) {
      errors.push(`器物「${nameOf(r.artifactId)}」的替代读数须为不小于 0 的整数`);
    }
  }
  for (const orig of target.readings) {
    if (!seen.has(orig.artifactId)) {
      errors.push(`补正缺少器物「${nameOf(orig.artifactId)}」的替代读数，器物集合必须与原轮一致`);
    }
  }
  const origIds = new Set(target.readings.map((r) => r.artifactId));
  for (const id of seen) {
    if (!origIds.has(id)) {
      errors.push(`补正包含原轮之外的器物「${nameOf(id)}」，器物集合必须与原轮一致`);
    }
  }
  return [...new Set(errors)];
}

/**
 * 构造追溯补正事件（写入前领域把关）。
 * 先校验结构规则，再把替代读数叠入原轮位置自首项记录重放，
 * 重新验证其后全部读数、换液、出槽；最早失去依据的事件将导致拒绝。
 *
 * @param {Array} events 当前事件日志（含 seq）
 * @param {number} targetSeq 被补正的 round-submitted 事件序号
 * @param {Array<{artifactId:string, value:number}>} readings 替代读数（采样时刻沿用原轮）
 */
export function buildRoundCorrectionEvent(events, targetSeq, readings) {
  const errors = validateCorrection(events, targetSeq, readings);
  if (errors.length > 0) throw new DomainError('补正不合法', errors);
  const target = events.find((e) => e.type === EVENT_TYPES.ROUND_SUBMITTED && e.seq === targetSeq);
  const byId = new Map(readings.map((r) => [r.artifactId, r.value]));
  const correction = {
    type: EVENT_TYPES.ROUND_CORRECTED,
    tankId: target.tankId,
    correctsSeq: target.seq,
    // 替代读数按原轮器物顺序排列；采样时刻不属于补正内容，完全沿用原轮。
    readings: target.readings.map((r) => ({ artifactId: r.artifactId, value: byId.get(r.artifactId) })),
  };
  const failure = revalidateEventStream([...events, { ...correction, seq: events.length + 1 }]);
  if (failure) {
    throw new DomainError(
      `补正会使第 #${failure.seq} 条记录失去依据：${failure.reason}`,
      [
        `第 #${failure.seq} 条记录将失去依据：${failure.reason}`,
        '只能保存不推翻既有读数、换液或出槽依据的读数纠正',
      ],
    );
  }
  return correction;
}

/**
 * 将日志中的补正叠入各自原轮位置，得到只含基础事件的有效事件流。
 * 原事件不被修改；补正事件本身不进入有效流。
 * 返回 { events } 或 { failure: { seq, reason } }。
 */
export function foldCorrections(events) {
  const folded = [];
  const roundIndexBySeq = new Map();
  const correctedSeqs = new Set();
  for (const event of events) {
    if (event.type !== EVENT_TYPES.ROUND_CORRECTED) {
      if (event.type === EVENT_TYPES.ROUND_SUBMITTED) roundIndexBySeq.set(event.seq, folded.length);
      folded.push(event);
      continue;
    }
    const index = roundIndexBySeq.get(event.correctsSeq);
    const target = index == null ? null : folded[index];
    if (!target) {
      return { failure: { seq: event.seq, reason: '补正目标不存在或不是一轮已提交的读数' } };
    }
    if (correctedSeqs.has(event.correctsSeq)) {
      return { failure: { seq: event.seq, reason: `第 #${event.correctsSeq} 条原轮已存在有效补正，同一原轮至多一条` } };
    }
    const byId = new Map(event.readings.map((r) => [r.artifactId, r.value]));
    const sameSet = byId.size === target.readings.length
      && target.readings.every((r) => byId.has(r.artifactId));
    if (!sameSet) {
      return { failure: { seq: event.seq, reason: `补正未恰好覆盖第 #${event.correctsSeq} 条原轮的器物集合` } };
    }
    if (event.readings.some((r) => !Number.isInteger(r.value) || r.value < 0)) {
      return { failure: { seq: event.seq, reason: '替代读数须为不小于 0 的整数' } };
    }
    folded[index] = {
      ...target,
      readings: target.readings.map((r) => ({ ...r, value: byId.get(r.artifactId) })),
    };
    correctedSeqs.add(event.correctsSeq);
  }
  return { events: folded };
}

/**
 * 自首项记录重放并逐事件重新验证既有规则（读数轮校验、换液与出槽资格）。
 * 日志中的补正先叠入原轮位置再验证。
 * 全部通过返回 null；否则返回最早受影响事件的 { seq, reason }。
 */
export function revalidateEventStream(events) {
  const folded = foldCorrections(events);
  if (folded.failure) return folded.failure;
  let state = null;
  for (const event of folded.events) {
    const reason = checkBaseEvent(state, event);
    if (reason) return { seq: event.seq, reason };
    state = applyEvent(state, event);
  }
  return null;
}

/** 按既有规则检查单条基础事件在当前重放状态下是否成立；成立返回 null。 */
function checkBaseEvent(state, event) {
  if (event.type === EVENT_TYPES.SCHEME_CREATED) {
    return state === null ? null : '建立方案只能是首项记录';
  }
  if (!state) return '首项记录必须是建立方案';
  const tank = state.tanks.find((t) => t.id === event.tankId);
  if (!tank) return `事件引用了不存在的槽位：${event.tankId}`;
  const derived = deriveTank(tank);
  switch (event.type) {
    case EVENT_TYPES.ROUND_SUBMITTED: {
      const errors = validateRound(derived, event.readings);
      return errors.length > 0 ? errors.join('；') : null;
    }
    case EVENT_TYPES.LIQUID_CHANGED: {
      if (derived.soakingCount === 0) return '换液时该槽器物均已出槽，换液失去依据';
      if (!derived.allSoakingEligible) return '换液时并非全部在泡器物共同连续达标（或末值高于上限）';
      return null;
    }
    case EVENT_TYPES.ARTIFACT_REMOVED: {
      const artifact = derived.artifacts.find((a) => a.id === event.artifactId);
      if (!artifact) return `事件引用了不存在的器物：${event.artifactId}`;
      if (artifact.status !== 'soaking') return `器物「${artifact.name}」在出槽前已不在浸泡`;
      if (!artifact.eligible) return `器物「${artifact.name}」出槽时未连续达到规定轮数（或末值高于上限）`;
      return null;
    }
    default:
      return `未知事件类型：${event.type}`;
  }
}

/** 由建立方案事件解析器物名称，用于错误信息。 */
function artifactNamer(events, targetRound) {
  const created = events.find((e) => e.type === EVENT_TYPES.SCHEME_CREATED);
  const tank = created && created.tanks.find((t) => t.id === targetRound.tankId);
  return (artifactId) => {
    const found = tank && tank.artifacts.find((a) => a.id === artifactId);
    return found ? found.name : artifactId;
  };
}
