import { buildSchemeCreatedEvent, DomainError } from '../domain/events.js';
import { validateSchemePayload } from '../domain/validate.js';
import { esc, fmtTs } from './dom.js';

const DEMO_PAYLOAD = {
  name: '2026 春季金属文物脱盐（示例）',
  tanks: [
    { name: '1 号槽', limit: 500, requiredRounds: 3, artifacts: [{ name: '青铜鼎' }, { name: '青铜镜' }, { name: '铜弩机' }] },
    { name: '2 号槽', limit: 300, requiredRounds: 2, artifacts: [{ name: '铁剑' }, { name: '铁釜' }] },
  ],
};

export function renderList(ctx) {
  const { store, root } = ctx;
  const schemes = store.listSchemes();
  root.innerHTML = `
    <section class="panel">
      <h2>监测方案</h2>
      ${schemes.length === 0
        ? '<p class="empty">暂无方案。请在下方建立槽位、器物初始归属、目标上限与所需连续轮数。</p>'
        : `<table class="grid">
            <thead><tr><th>方案</th><th>创建时间</th><th>修订号</th><th></th></tr></thead>
            <tbody>${schemes.map((s) => `<tr>
              <td>${esc(s.name)}</td>
              <td>${fmtTs(Date.parse(s.createdAt))}</td>
              <td><span class="rev">r${s.revision}</span></td>
              <td><a class="btn-link" href="#/scheme/${encodeURIComponent(s.id)}">打开</a></td>
            </tr>`).join('')}</tbody>
          </table>`}
    </section>
    <section class="panel">
      <h2>建立新方案</h2>
      <p class="muted">同一槽内器物须共同经历足够的连续达标轮数后才可换液；所需连续轮数至少为 2，避免把单件短暂下降误作整槽合格。</p>
      <form id="create-form" novalidate>
        <label class="field">方案名称
          <input type="text" name="schemeName" required placeholder="如：2026 春季青铜器脱盐">
        </label>
        <div id="tank-list"></div>
        <div class="actions">
          <button type="button" id="add-tank">＋ 添加槽位</button>
          <button type="button" id="load-demo">载入示例</button>
          <button type="submit" class="primary">建立方案</button>
        </div>
        <div class="errors" id="create-errors" hidden></div>
      </form>
    </section>`;

  const tankList = root.querySelector('#tank-list');
  const errorsBox = root.querySelector('#create-errors');

  function tankFieldsetHtml(tank) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'tank-fieldset';
    fieldset.innerHTML = `
      <legend>槽位</legend>
      <label class="field">槽位名称
        <input type="text" data-tank="name" value="${esc(tank ? tank.name : '')}" placeholder="如：1 号槽">
      </label>
      <label class="field">目标上限（整数 µS/cm）
        <input type="number" min="0" step="1" data-tank="limit" value="${tank ? tank.limit : ''}" placeholder="如：500">
      </label>
      <label class="field">所需连续轮数（≥2）
        <input type="number" min="2" step="1" data-tank="rounds" value="${tank ? tank.requiredRounds : 3}">
      </label>
      <label class="field">器物初始归属（每行一件）
        <textarea data-tank="artifacts" rows="3" placeholder="青铜鼎&#10;青铜镜">${tank ? esc(tank.artifacts.map((a) => a.name).join('\n')) : ''}</textarea>
      </label>
      <button type="button" data-remove-tank>移除槽位</button>`;
    fieldset.querySelector('[data-remove-tank]').addEventListener('click', () => fieldset.remove());
    return fieldset;
  }

  function addTank(tank) {
    tankList.appendChild(tankFieldsetHtml(tank));
  }

  function fillForm(payload) {
    root.querySelector('[name="schemeName"]').value = payload.name;
    tankList.innerHTML = '';
    payload.tanks.forEach(addTank);
  }

  root.querySelector('#add-tank').addEventListener('click', () => addTank(null));
  root.querySelector('#load-demo').addEventListener('click', () => fillForm(DEMO_PAYLOAD));

  root.querySelector('#create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      name: root.querySelector('[name="schemeName"]').value,
      tanks: [...tankList.querySelectorAll('.tank-fieldset')].map((fieldset) => {
        const val = (key) => fieldset.querySelector(`[data-tank="${key}"]`).value;
        return {
          name: val('name'),
          limit: val('limit') === '' ? NaN : Number(val('limit')),
          requiredRounds: val('rounds') === '' ? NaN : Number(val('rounds')),
          artifacts: val('artifacts').split('\n').map((line) => line.trim()).filter(Boolean)
            .map((name) => ({ name })),
        };
      }),
    };
    const errors = validateSchemePayload(payload);
    if (errors.length > 0) {
      errorsBox.hidden = false;
      errorsBox.innerHTML = errors.map(esc).join('<br>');
      return;
    }
    errorsBox.hidden = true;
    try {
      const createdEvent = buildSchemeCreatedEvent(payload);
      const record = await store.createScheme(createdEvent);
      window.location.hash = `#/scheme/${encodeURIComponent(record.id)}`;
    } catch (err) {
      errorsBox.hidden = false;
      errorsBox.textContent = err instanceof DomainError ? err.errors.join('；') : String(err);
    }
  });

  addTank(null);
}
