import { replayScheme, deriveTank } from '../domain/replay.js';
import {
  buildRoundEvent,
  buildLiquidChangeEvent,
  buildRemovalEvent,
  DomainError,
  EVENT_TYPES,
} from '../domain/events.js';
import { buildRoundCorrectionEvent, validateCorrection } from '../domain/correction.js';
import { validateRound } from '../domain/validate.js';
import { ConflictError } from '../store/recordStore.js';
import { esc, fmtTs, toLocalInputValue } from './dom.js';

/**
 * 方案详情页：每槽本轮趋势、下一步资格、修订号、自首项记录重放的不可改写过程。
 * 所有变更操作均以渲染时所见的修订号提交；发生冲突时拒绝写入并展示最新状态。
 * 对已提交的整轮读数可在过程记录中提出追溯补正：仅替换读数，
 * 器物集合与采样时刻保持不变；补正叠入原轮位置重放并重新验证其后全部记录。
 */
export function renderDetail(ctx, schemeId, options = {}) {
  const { store, root } = ctx;
  const record = store.load(schemeId);
  if (!record) {
    root.innerHTML = `<section class="panel"><p class="empty">未找到该方案。<a href="#/">返回方案列表</a></p></section>`;
    return;
  }
  const state = replayScheme(record.events);
  const tanks = state.tanks.map(deriveTank);

  root.innerHTML = `
    <section class="panel scheme-head">
      <a class="back" href="#/">← 返回方案列表</a>
      <div class="scheme-title">
        <h2>${esc(state.name)}</h2>
        <span class="rev" title="每次写入修订号 +1；操作须以所见修订号提交">修订号 r${record.revision}</span>
      </div>
      <p class="muted">共 ${record.events.length} 条记录 · 当前状态自首项记录重放生成 · 记录不可改写</p>
      ${options.banner ? `<div class="banner warn">${esc(options.banner)}</div>` : ''}
    </section>
    ${tanks.map((tank) => tankCardHtml(tank)).join('')}
    <section class="panel">
      <h3>过程记录（自首项记录重放 · 不可改写）</h3>
      <ol class="log">${record.events.map((ev) => `<li>${renderEvent(ev, state, record.events, options)}</li>`).join('')}</ol>
    </section>`;

  bindDetail(ctx, record, tanks);
}

function tankCardHtml(tank) {
  return `
  <section class="panel tank" data-tank-id="${tank.id}">
    <div class="tank-head">
      <h3>${esc(tank.name)}</h3>
      <p class="muted">目标上限 ${tank.limit} µS/cm · 需连续 ${tank.requiredRounds} 轮严格下降且末值达标 · 已换液 ${tank.liquidChanges} 次 · 当前周期已完成 ${tank.periodRounds.length} 轮</p>
    </div>
    <table class="grid">
      <thead><tr><th>器物</th><th>状态</th><th>本轮趋势</th><th>连续达标</th><th>末值</th><th>资格</th><th>操作</th></tr></thead>
      <tbody>${tank.artifacts.map((a) => artifactRowHtml(tank, a)).join('')}</tbody>
    </table>
    ${tank.allRemoved
      ? '<p class="done">✅ 全部器物已出槽，本槽监测完成。</p>'
      : `${nextStepHtml(tank)}${roundFormHtml(tank)}`}
  </section>`;
}

function artifactRowHtml(tank, a) {
  const trend = a.periodReadings.length > 0
    ? a.periodReadings.map((r) => (r.corrected
      ? `<span class="corrected" title="该轮读数已经追溯补正">${r.value}✎</span>`
      : String(r.value))).join(' → ')
    : '—';
  const lastOk = a.lastValue != null && a.lastValue <= tank.limit;
  return `<tr>
    <td>${esc(a.name)}</td>
    <td>${a.status === 'soaking' ? '浸泡中' : '已出槽'}</td>
    <td class="trend">${trend}</td>
    <td><span class="badge ${a.eligible ? 'ok' : 'pending'}">${a.streak}/${tank.requiredRounds}</span></td>
    <td>${a.lastValue == null
      ? '—'
      : `<span class="${lastOk ? 'ok-text' : 'bad-text'}">${a.lastValue}</span> <span class="muted">/ ≤${tank.limit}</span>`}</td>
    <td>${a.status !== 'soaking'
      ? '—'
      : a.eligible
        ? '<span class="badge ok">达标</span>'
        : '<span class="badge pending">未达标</span>'}</td>
    <td>${a.status === 'soaking'
      ? `<button data-action="remove" data-tank="${tank.id}" data-artifact="${a.id}" ${a.eligible ? '' : 'disabled title="未连续达标，不能出槽"'}>出槽</button>`
      : '—'}</td>
  </tr>`;
}

function nextStepHtml(tank) {
  const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
  const blockers = soaking
    .filter((a) => !a.eligible)
    .map((a) => {
      const parts = [`连续 ${a.streak}/${tank.requiredRounds} 轮`];
      if (a.lastValue == null) parts.push('尚无读数');
      else if (a.lastValue > tank.limit) parts.push(`末值 ${a.lastValue} 高于上限`);
      return `「${esc(a.name)}」${parts.join('、')}`;
    })
    .join('；');
  const removable = soaking.filter((a) => a.eligible).map((a) => `「${esc(a.name)}」`).join('、');
  return `<div class="next-step">
    <h4>下一步资格</h4>
    <ul>
      <li>提交读数：可提交本周期第 ${tank.nextRoundInPeriod} 轮，须恰含 ${tank.soakingCount} 件在泡器物各一次整数读数，且采样时间严格递增。</li>
      <li>换液：${tank.allSoakingEligible
        ? '✅ 全部在泡器物已共同达标，可执行换液（换液后本槽轮次清零）。'
        : `❌ 暂不可换液 —— ${blockers}`}</li>
      <li>出槽：${removable ? `✅ 可出槽：${removable}` : '暂无器物达到出槽条件。'}</li>
    </ul>
    <div class="actions">
      <button data-action="liquid" data-tank="${tank.id}" ${tank.allSoakingEligible ? '' : 'disabled title="全部在泡器物共同达标后才可换液"'}>执行换液</button>
    </div>
  </div>`;
}

function roundFormHtml(tank) {
  const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
  // 预填严格递增且晚于历史读数的采样时间（分钟精度，逐件 +1 分钟）。
  const baseMinute = Math.ceil(Math.max(Date.now(), (tank.lastTs ?? 0) + 1) / 60000) * 60000;
  const rows = soaking.map((a, i) => `
    <div class="reading-row" data-artifact="${a.id}">
      <span class="reading-name">${esc(a.name)}</span>
      <label>电导率（整数 µS/cm）
        <input type="number" min="0" step="1" required data-field="value" placeholder="如：980">
      </label>
      <label>采样时间
        <input type="datetime-local" required data-field="ts" value="${toLocalInputValue(baseMinute + i * 60000)}">
      </label>
    </div>`).join('');
  return `<form class="round-form" data-tank="${tank.id}" novalidate>
    <h4>提交本周期第 ${tank.nextRoundInPeriod} 轮读数</h4>
    ${rows}
    <div class="errors" hidden></div>
    <div class="actions"><button type="submit" class="primary">提交第 ${tank.nextRoundInPeriod} 轮读数</button></div>
  </form>`;
}

function renderEvent(ev, state, events, options = {}) {
  const time = fmtTs(Date.parse(ev.at));
  const nameOf = artifactNamer(state, ev.tankId);
  switch (ev.type) {
    case EVENT_TYPES.SCHEME_CREATED: {
      const tanks = ev.tanks.map((t) => `槽「${esc(t.name)}」（上限 ${t.limit} µS/cm，需连续 ${t.requiredRounds} 轮，${t.artifacts.length} 件器物：${t.artifacts.map((a) => esc(a.name)).join('、')}）`).join('；');
      return `<strong>#${ev.seq}</strong> <span class="muted">${time}</span> 建立方案「${esc(ev.name)}」：${tanks}`;
    }
    case EVENT_TYPES.ROUND_SUBMITTED: {
      const tank = state.tanks.find((t) => t.id === ev.tankId);
      const readings = ev.readings
        .map((r) => `${esc(nameOf(r.artifactId))}=${r.value} µS/cm @ ${fmtTs(r.ts)}`)
        .join('，');
      const correction = events.find((e) => e.type === EVENT_TYPES.ROUND_CORRECTED && e.correctsSeq === ev.seq);
      const note = correction
        ? ` <span class="badge pending">已被 #${correction.seq} 追溯补正，当前以补正后重放为准</span>`
        : '';
      const action = correction
        ? ''
        : options.correctingSeq === ev.seq
          ? correctionFormHtml(ev, nameOf)
          : ` <button type="button" class="link-btn" data-action="correct" data-seq="${ev.seq}" title="该轮读数抄错时提出替代读数；器物集合与采样时刻保持不变">补正本轮</button>`;
      return `<strong>#${ev.seq}</strong> <span class="muted">${time}</span> 槽「${esc(tank ? tank.name : ev.tankId)}」第 ${ev.period + 1} 周期第 ${ev.roundInPeriod} 轮读数：${readings}${note}${action}`;
    }
    case EVENT_TYPES.ROUND_CORRECTED: {
      const tank = state.tanks.find((t) => t.id === ev.tankId);
      const target = events.find((e) => e.seq === ev.correctsSeq);
      const changes = ev.readings
        .map((r) => {
          const orig = target && target.readings.find((o) => o.artifactId === r.artifactId);
          return `${esc(nameOf(r.artifactId))}=${r.value} µS/cm（原 ${orig ? orig.value : '?'}）`;
        })
        .join('，');
      return `<strong>#${ev.seq}</strong> <span class="muted">${time}</span> 追溯补正第 #${ev.correctsSeq} 条（槽「${esc(tank ? tank.name : ev.tankId)}」）：${changes}；器物集合与采样时刻沿用原轮`;
    }
    case EVENT_TYPES.LIQUID_CHANGED: {
      const tank = state.tanks.find((t) => t.id === ev.tankId);
      return `<strong>#${ev.seq}</strong> <span class="muted">${time}</span> 槽「${esc(tank ? tank.name : ev.tankId)}」执行换液，该槽轮次清零`;
    }
    case EVENT_TYPES.ARTIFACT_REMOVED: {
      return `<strong>#${ev.seq}</strong> <span class="muted">${time}</span> 器物「${esc(nameOf(ev.artifactId))}」完成出槽，不再接受读数`;
    }
    default:
      return `<strong>#${ev.seq}</strong> <span class="muted">${time}</span> 未知事件`;
  }
}

/** 由重放状态解析器物名称（跨槽查找，供过程记录展示）。 */
function artifactNamer(state, tankId) {
  const tank = state.tanks.find((t) => t.id === tankId);
  return (artifactId) => {
    const found = tank && tank.artifacts.find((a) => a.id === artifactId);
    return found ? found.name : artifactId;
  };
}

/** 追溯补正表单：仅可替换读数；器物集合与采样时刻完全沿用原轮。 */
function correctionFormHtml(ev, nameOf) {
  const rows = ev.readings.map((r) => `
    <div class="reading-row" data-artifact="${r.artifactId}">
      <span class="reading-name">${esc(nameOf(r.artifactId))}</span>
      <label>替代读数（整数 µS/cm）
        <input type="number" min="0" step="1" required data-field="value" value="${r.value}">
      </label>
      <span class="muted keep-ts">采样时刻沿用原轮：${fmtTs(r.ts)}</span>
    </div>`).join('');
  return `<form class="correction-form" data-seq="${ev.seq}" novalidate>
    <h4>追溯补正第 #${ev.seq} 条读数</h4>
    <p class="muted">仅可替换读数，器物集合与采样时刻保持不变。提交后替代读数将叠入原轮位置自首项记录重放，并重新验证其后每次读数、换液与出槽；若推翻既有处置依据将被拒绝。</p>
    ${rows}
    <div class="errors" hidden></div>
    <div class="actions">
      <button type="submit" class="primary">提交补正</button>
      <button type="button" data-action="cancel-correction">取消</button>
    </div>
  </form>`;
}

function bindDetail(ctx, record, tanks) {
  const { root } = ctx;
  const tankById = new Map(tanks.map((t) => [t.id, t]));

  root.querySelectorAll('form.round-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const tank = tankById.get(form.dataset.tank);
      const errBox = form.querySelector('.errors');
      const readings = [...form.querySelectorAll('.reading-row')].map((row) => {
        const valueRaw = row.querySelector('[data-field="value"]').value;
        const tsRaw = row.querySelector('[data-field="ts"]').value;
        return {
          artifactId: row.dataset.artifact,
          value: valueRaw === '' ? NaN : Number(valueRaw),
          ts: tsRaw ? new Date(tsRaw).getTime() : NaN,
        };
      });
      const errors = validateRound(tank, readings);
      if (errors.length > 0) {
        errBox.hidden = false;
        errBox.innerHTML = errors.map(esc).join('<br>');
        return;
      }
      errBox.hidden = true;
      await mutate(ctx, record, () => buildRoundEvent(tank, readings), '读数已提交');
    });
  });

  root.querySelectorAll('button[data-action="liquid"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tank = tankById.get(btn.dataset.tank);
      await mutate(ctx, record, () => buildLiquidChangeEvent(tank), '已执行换液，本槽轮次清零');
    });
  });

  root.querySelectorAll('button[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tank = tankById.get(btn.dataset.tank);
      await mutate(ctx, record, () => buildRemovalEvent(tank, btn.dataset.artifact), '器物已出槽');
    });
  });

  // 打开某一轮的追溯补正表单（同一时刻只展开一轮）。
  root.querySelectorAll('button[data-action="correct"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      renderDetail(ctx, record.id, { correctingSeq: Number(btn.dataset.seq) });
    });
  });

  root.querySelectorAll('button[data-action="cancel-correction"]').forEach((btn) => {
    btn.addEventListener('click', () => renderDetail(ctx, record.id));
  });

  root.querySelectorAll('form.correction-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const targetSeq = Number(form.dataset.seq);
      const errBox = form.querySelector('.errors');
      const readings = [...form.querySelectorAll('.reading-row')].map((row) => {
        const valueRaw = row.querySelector('[data-field="value"]').value;
        return { artifactId: row.dataset.artifact, value: valueRaw === '' ? NaN : Number(valueRaw) };
      });
      const errors = validateCorrection(record.events, targetSeq, readings);
      if (errors.length > 0) {
        errBox.hidden = false;
        errBox.innerHTML = errors.map(esc).join('<br>');
        return;
      }
      errBox.hidden = true;
      await mutate(
        ctx,
        record,
        () => buildRoundCorrectionEvent(record.events, targetSeq, readings),
        '补正已提交，当前状态已按补正后重放还原',
        { correctingSeq: targetSeq },
      );
    });
  });
}

/**
 * 以所见修订号提交事件；陈旧操作不得写入，并展示最新状态。
 * renderOptions 用于领域校验失败时保持原操作上下文（如补正表单保持展开）。
 */
async function mutate(ctx, record, buildEvent, successMessage, renderOptions = {}) {
  let event;
  try {
    event = buildEvent();
  } catch (err) {
    if (err instanceof DomainError) {
      renderDetail(ctx, record.id, { ...renderOptions, banner: err.errors.join('；') });
      return;
    }
    throw err;
  }
  try {
    await ctx.store.append(record.id, event, record.revision);
    renderDetail(ctx, record.id);
    ctx.toast(`${successMessage}（修订号 r${record.revision + 1}）`);
  } catch (err) {
    if (err instanceof ConflictError) {
      renderDetail(ctx, record.id, {
        banner: `该方案已在其他标签页或窗口更新（最新修订号 r${err.current.revision}），本次操作未写入，已为您显示最新状态。`,
      });
      return;
    }
    throw err;
  }
}
