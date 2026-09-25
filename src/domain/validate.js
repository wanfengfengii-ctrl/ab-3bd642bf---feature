/**
 * 纯校验函数：不依赖浏览器，可在 Node 中直接测试。
 * 所有函数返回错误信息数组（空数组表示通过），不抛异常。
 */

/** 校验建立方案的入参（槽位、器物初始归属、目标上限、所需连续轮数）。 */
export function validateSchemePayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return ['方案参数缺失'];
  }
  if (!payload.name || !String(payload.name).trim()) {
    errors.push('方案名称不能为空');
  }
  if (!Array.isArray(payload.tanks) || payload.tanks.length === 0) {
    errors.push('至少需要一个槽位');
    return errors;
  }
  payload.tanks.forEach((tank, i) => {
    const label = `槽位 ${i + 1}`;
    if (!tank || typeof tank !== 'object') {
      errors.push(`${label}：参数缺失`);
      return;
    }
    if (!tank.name || !String(tank.name).trim()) {
      errors.push(`${label}：名称不能为空`);
    }
    if (!Number.isInteger(tank.limit) || tank.limit < 0) {
      errors.push(`${label}：目标上限须为不小于 0 的整数`);
    }
    if (!Number.isInteger(tank.requiredRounds) || tank.requiredRounds < 2) {
      errors.push(`${label}：所需连续轮数须为不小于 2 的整数（避免把单件短暂下降误作整槽合格）`);
    }
    if (!Array.isArray(tank.artifacts) || tank.artifacts.length === 0) {
      errors.push(`${label}：至少需要一件器物`);
    } else {
      tank.artifacts.forEach((artifact, j) => {
        if (!artifact || !artifact.name || !String(artifact.name).trim()) {
          errors.push(`${label}：第 ${j + 1} 件器物名称不能为空`);
        }
      });
    }
  });
  return errors;
}

/**
 * 校验一轮读数。规则：
 * - 槽内仍有在泡器物时才接受读数；
 * - 恰含每件在泡器物各一次读数（不多、不少、不重复、不含已出槽器物）；
 * - 读数为不小于 0 的整数；
 * - 采样时间在本轮内严格递增，且晚于本槽此前全部读数。
 *
 * @param {object} tank 由 deriveTank 派生的槽状态
 * @param {Array<{artifactId:string, value:number, ts:number}>} readings
 */
export function validateRound(tank, readings) {
  const errors = [];
  const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
  if (soaking.length === 0) {
    return ['该槽器物均已出槽，不再接受读数'];
  }
  if (!Array.isArray(readings) || readings.length === 0) {
    return ['本轮读数为空'];
  }

  const seen = new Set();
  for (const r of readings) {
    if (seen.has(r.artifactId)) {
      errors.push('同一器物在一轮中只能提交一次读数');
      break;
    }
    seen.add(r.artifactId);
  }

  const soakingById = new Map(soaking.map((a) => [a.id, a]));
  for (const r of readings) {
    const artifact = soakingById.get(r.artifactId);
    if (!artifact) {
      errors.push('包含已出槽或不属于本槽的器物读数');
      continue;
    }
    if (!Number.isInteger(r.value) || r.value < 0) {
      errors.push(`器物「${artifact.name}」的读数须为不小于 0 的整数`);
    }
    if (!Number.isFinite(r.ts)) {
      errors.push(`器物「${artifact.name}」的采样时间无效`);
    }
  }

  for (const artifact of soaking) {
    if (!seen.has(artifact.id)) {
      errors.push(`缺少器物「${artifact.name}」的本轮读数`);
    }
  }

  for (let i = 1; i < readings.length; i += 1) {
    if (!(readings[i].ts > readings[i - 1].ts)) {
      errors.push('同一轮内各器物的采样时间必须严格递增');
      break;
    }
  }

  if (
    readings.length > 0
    && Number.isFinite(readings[0].ts)
    && tank.lastTs != null
    && !(readings[0].ts > tank.lastTs)
  ) {
    errors.push('本轮采样时间必须晚于本槽此前全部读数');
  }

  return [...new Set(errors)];
}
