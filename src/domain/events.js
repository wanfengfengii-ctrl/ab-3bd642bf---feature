/**
 * 事件构造器：所有写入都表现为追加一条不可改写的事件。
 * 构造前做领域校验，不合法则抛 DomainError（携带全部错误信息）。
 */
import { validateRound, validateSchemePayload } from './validate.js';
// 与 replay.js 互相引用：ESM 活动绑定保证此处取到运行时的重放函数。
import { replayWithCorrections } from './replay.js';

export const EVENT_TYPES = Object.freeze({
  SCHEME_CREATED: 'scheme-created',
  ROUND_SUBMITTED: 'round-submitted',
  LIQUID_CHANGED: 'liquid-changed',
  ARTIFACT_REMOVED: 'artifact-removed',
  ROUND_CORRECTED: 'round-corrected',
});

export class DomainError extends Error {
  constructor(message, errors = [message]) {
    super(message);
    this.name = 'DomainError';
    this.errors = errors;
  }
}

export function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 非安全上下文（如 http 局域网访问）下 randomUUID 不可用时的退化方案
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 建立方案（首项记录）。genId 可注入以便测试。 */
export function buildSchemeCreatedEvent(payload, genId = randomId) {
  const errors = validateSchemePayload(payload);
  if (errors.length > 0) throw new DomainError('方案参数不合法', errors);
  return {
    type: EVENT_TYPES.SCHEME_CREATED,
    schemeId: genId(),
    name: String(payload.name).trim(),
    tanks: payload.tanks.map((tank) => ({
      id: genId(),
      name: String(tank.name).trim(),
      limit: tank.limit,
      requiredRounds: tank.requiredRounds,
      artifacts: tank.artifacts.map((a) => ({ id: genId(), name: String(a.name).trim() })),
    })),
  };
}

/**
 * 提交一轮读数。readings 顺序即采样顺序。
 * @param {object} tank 由 deriveTank 派生的槽状态
 */
export function buildRoundEvent(tank, readings) {
  const errors = validateRound(tank, readings);
  if (errors.length > 0) throw new DomainError('本轮读数不合法', errors);
  return {
    type: EVENT_TYPES.ROUND_SUBMITTED,
    tankId: tank.id,
    period: tank.liquidChanges,
    roundInPeriod: tank.nextRoundInPeriod,
    readings: readings.map((r) => ({ artifactId: r.artifactId, value: r.value, ts: r.ts })),
  };
}

/** 换液：仅当全部在泡器物共同连续达标时才可执行；执行后该槽轮次清零。 */
export function buildLiquidChangeEvent(tank) {
  if (tank.soakingCount === 0) throw new DomainError('该槽器物均已出槽，无需换液');
  if (!tank.allSoakingEligible) {
    throw new DomainError('尚有在泡器物未连续达到规定轮数（或末值高于上限），不能换液');
  }
  return { type: EVENT_TYPES.LIQUID_CHANGED, tankId: tank.id };
}

/** 出槽：仅当该器物自身连续达标时才可执行；出槽后不再接受读数。 */
export function buildRemovalEvent(tank, artifactId) {
  const artifact = tank.artifacts.find((a) => a.id === artifactId);
  if (!artifact) throw new DomainError('器物不存在');
  if (artifact.status !== 'soaking') throw new DomainError(`器物「${artifact.name}」已出槽，不能重复操作`);
  if (!artifact.eligible) {
    throw new DomainError(`器物「${artifact.name}」尚未连续达到规定轮数（或末值高于上限），不能出槽`);
  }
  return { type: EVENT_TYPES.ARTIFACT_REMOVED, tankId: tank.id, artifactId };
}

/**
 * 对一轮已提交读数提出追溯补正（原记录保留，补正以追加事件形式存在）。
 * 约束：
 * - target 为原轮的 round-submitted 事件（按 seq 定位）；
 * - 器物集合与采样时刻完全沿用原轮，提交者只能按原轮位置给出非负整数读数；
 * - 同一原轮至多有一条有效补正（重复补正被拒绝）。
 *
 * 重放校验由 replay.js 的 replayWithCorrections 完成：
 * 把替代读数叠入原轮位置后自首项记录重放，原轮之后的每次读数、换液、出槽
 * 都必须仍符合既有规则，否则抛 DomainError 并在 errors[0] 给出最早受影响事件及原因。
 *
 * @param {Array<object>} events 已追加的事件日志（含 seq）
 * @param {number} targetSeq 原轮事件的 seq
 * @param {Array<{artifactId:string, value:number}>} replacements 按原轮位置给出的替代读数（不含 ts）
 */
export function buildRoundCorrectionEvent(events, targetSeq, replacements) {
  const result = replayWithCorrections(events, [{ targetSeq, replacements }]);
  if (result.error) {
    throw new DomainError(result.error.message, [result.error.message]);
  }
  const original = events.find((e) => e.seq === targetSeq);
  return {
    type: EVENT_TYPES.ROUND_CORRECTED,
    tankId: original.tankId,
    targetSeq,
    // 器物集合与采样时刻完全保持不变，仅替换每件器物的非负整数读数。
    readings: original.readings.map((r, i) => ({
      artifactId: r.artifactId,
      value: result.corrections[0].values[i],
      ts: r.ts,
    })),
  };
}
