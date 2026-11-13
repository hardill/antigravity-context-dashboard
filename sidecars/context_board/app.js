function syncColorScheme() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
  const m = /^#([0-9a-f]{6})$/i.exec(bg) || /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(bg);
  let isDark = true;
  if (m && m.length === 2) {
    const n = parseInt(m[1], 16);
    const lum = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
    isDark = lum < 128;
  } else if (m && m.length === 4) {
    const lum = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000;
    isDark = lum < 128;
  }
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

window.addEventListener('message', (e) => {
  if (e.data?.type === 'theme-change') {
    queueMicrotask(syncColorScheme);
  }
});
syncColorScheme();

const state = {
  followActive: true,
  selectedConvId: '',
  activeTab: 'context',
  turnsLimit: 20,
  collapsed: localStorage.getItem('cd_collapsed') !== 'false',
  historyLoaded: false,
  timer: null,
};

function applyCollapseState() {
  const shell = document.querySelector('.shell');
  const btn = document.getElementById('collapse-btn');
  if (!shell || !btn) return;
  shell.classList.toggle('is-collapsed', state.collapsed);
  btn.textContent = state.collapsed ? '▾ 展开' : '▴ 精简';
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  return String(v);
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtReset(iso) {
  if (!iso) return '未知';
  const diff = Date.parse(iso) - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return '即将重置';
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}天${hrs % 24}小时后`;
  if (hrs > 0) return `${hrs}小时${mins % 60}分后`;
  return `${mins}分钟后`;
}

function pctClass(pct) {
  if (pct >= 80) return 'danger';
  if (pct >= 50) return 'warn';
  return '';
}

function apiFetch(url) {
  const fetcher = window.sidecar?.fetch || fetch;
  return fetcher(url).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

function renderConversations(conversations, currentId, hostId) {
  const select = document.getElementById('conv-select');
  select.innerHTML = '';

  const autoOpt = document.createElement('option');
  autoOpt.value = '__auto__';
  autoOpt.textContent = '⚡ 自动跟随当前活跃会话';
  select.appendChild(autoOpt);

  for (const c of conversations) {
    const opt = document.createElement('option');
    opt.value = c.id;
    const tag = c.id === hostId ? '★ ' : '';
    const running = c.status === 'CASCADE_RUN_STATUS_RUNNING' ? '[运行中] ' : '';
    opt.textContent = `${tag}${running}${c.summary}`;
    select.appendChild(opt);
  }

  if (state.followActive) {
    select.value = '__auto__';
  } else if (state.selectedConvId && [...select.options].some((o) => o.value === state.selectedConvId)) {
    select.value = state.selectedConvId;
  } else if (currentId && [...select.options].some((o) => o.value === currentId)) {
    select.value = currentId;
  }
}

function renderCompactBar(snapshot) {
  const el = document.getElementById('compact-text');
  if (!el) return;
  if (!snapshot || snapshot.empty) {
    el.textContent = '暂无活跃会话';
    return;
  }
  const model = snapshot.activeModel?.label || 'Unknown';
  const ctx = snapshot.context || {};
  const tot = snapshot.totals || {};
  const spd = snapshot.speed || {};
  const hit = `${((tot.avgCacheHitRate || 0) * 100).toFixed(0)}%`;
  const speedPart = spd.lastTokensPerSec != null
    ? `${spd.lastTokensPerSec} tok/s`
    : fmtDuration(spd.lastDurationMs);
  const compFlag = ctx.compressionEvents > 0 ? ' · 🗜' : '';
  el.textContent = `${model} · ${fmtNum(ctx.currentTokens)}/${fmtNum(ctx.compressionLimit)} (${ctx.compressionPct}%)${compFlag} · 缓${hit} · ${speedPart}`;
}

function renderContext(snapshot) {
  const emptyEl = document.getElementById('context-empty');
  const bodyEl = document.getElementById('context-body');
  const modelPill = document.getElementById('model-pill');

  if (!snapshot || snapshot.empty) {
    emptyEl.classList.remove('hidden');
    bodyEl.classList.add('hidden');
    modelPill.textContent = '无会话';
    return;
  }

  emptyEl.classList.add('hidden');
  bodyEl.classList.remove('hidden');

  modelPill.textContent = snapshot.activeModel?.label || 'Unknown';

  const ctx = snapshot.context;
  const compPct = Math.min(100, ctx.compressionPct || 0);
  const modelPct = Math.min(100, ctx.modelPct || 0);

  document.getElementById('comp-text').textContent =
    `${fmtNum(ctx.currentTokens)} / ${fmtNum(ctx.compressionLimit)} (${ctx.compressionPct}%)`;
  const compBar = document.getElementById('comp-bar');
  compBar.style.width = `${compPct}%`;
  compBar.className = `progress-fill ${pctClass(ctx.compressionPct)}`;

  document.getElementById('model-ctx-text').textContent =
    `${fmtNum(ctx.currentTokens)} / ${fmtNum(ctx.modelContextLimit)} (${ctx.modelPct}%)`;
  document.getElementById('model-ctx-bar').style.width = `${modelPct}%`;

  const compressBadge = document.getElementById('compress-badge');
  if (ctx.compressionEvents > 0) {
    compressBadge.textContent = `🗜 已压缩 ${ctx.compressionEvents} 次`;
    compressBadge.classList.remove('hidden');
  } else {
    compressBadge.classList.add('hidden');
  }

  const tot = snapshot.totals;
  const spd = snapshot.speed;
  document.getElementById('kpi-input').textContent = `${fmtNum(ctx.freshInput)} / ${fmtNum(ctx.cacheRead)}`;
  document.getElementById('kpi-cache-rate').textContent =
    `累计命中 ${(tot.avgCacheHitRate * 100).toFixed(1)}%`;

  document.getElementById('kpi-speed').textContent =
    spd.lastTokensPerSec != null ? `${spd.lastTokensPerSec} tok/s` : fmtDuration(spd.lastDurationMs);
  document.getElementById('kpi-ttft').textContent =
    `TTFT ${fmtDuration(spd.lastTtftMs)} · 总 ${fmtDuration(spd.lastDurationMs)}`;

  document.getElementById('kpi-total').textContent = fmtNum(tot.allTokens);
  document.getElementById('kpi-calls').textContent = `${tot.apiCalls} 次模型调用`;

  document.getElementById('kpi-output-split').textContent = `${fmtNum(tot.thinking)} / ${fmtNum(tot.response)}`;
  document.getElementById('kpi-avg-speed').textContent =
    spd.avgTokensPerSec != null ? `均速 ${spd.avgTokensPerSec} tok/s` : '均速 —';

  const pag = snapshot.turnsPagination || {
    showing: snapshot.recentTurns.length,
    total: snapshot.recentTurns.length,
    hasMore: false,
  };
  document.getElementById('turns-count').textContent = `显示 ${pag.showing} / ${pag.total} 条`;
  const listEl = document.getElementById('turns-list');
  listEl.innerHTML = '';

  for (const t of snapshot.recentTurns) {
    const row = document.createElement('div');
    row.className = 'turn-row';
    const compressTag = t.compressed ? ' · 🗜压缩' : '';
    const speedTxt = t.tokensPerSec != null ? `${t.tokensPerSec} tok/s` : '—';
    let deltaHtml = '';
    if (typeof t.deltaTokens === 'number' && t.deltaTokens !== 0) {
      const sign = t.deltaTokens > 0 ? '+' : '-';
      const cls = t.compressed ? 'delta-badge compress' : 'delta-badge';
      deltaHtml = `<span class="${cls}">(${sign}${fmtNum(Math.abs(t.deltaTokens))})</span>`;
    }
    const actionHtml = t.actionSummary
      ? `<div class="turn-action" title="${esc(t.actionSummary)}">${esc(t.actionSummary)}</div>`
      : '';
    row.innerHTML = `
      <div class="row-top">
        <span><strong>#${t.stepIndex}</strong> ${esc(t.modelLabel)}${compressTag}</span>
        <span class="mono">${fmtNum(t.contextTokens)} ctx${deltaHtml}</span>
      </div>
      ${actionHtml}
      <div class="row-sub mono">
        <span>新:${fmtNum(t.freshInput)}</span>
        <span>缓:${fmtNum(t.cacheRead)} (${(t.cacheHitRate * 100).toFixed(0)}%)</span>
        <span>出:${fmtNum(t.output)} (思:${fmtNum(t.thinking)})</span>
        <span>耗时:${fmtDuration(t.durationMs)} · TTFT:${fmtDuration(t.ttftMs)} · ${speedTxt}</span>
      </div>
    `;
    listEl.appendChild(row);
  }

  const pagerEl = document.getElementById('turns-pager');
  const moreBtn = document.getElementById('turns-more-btn');
  const resetBtn = document.getElementById('turns-reset-btn');
  const remaining = Math.max(0, pag.total - pag.showing);
  if (pag.hasMore || state.turnsLimit > 20) {
    pagerEl.classList.remove('hidden');
    moreBtn.classList.toggle('hidden', !pag.hasMore);
    if (pag.hasMore) {
      const nextStep = Math.min(20, remaining);
      moreBtn.textContent = `查看更多 (+${nextStep}，还剩 ${remaining} 条)`;
    }
    resetBtn.classList.toggle('hidden', state.turnsLimit <= 20);
  } else {
    pagerEl.classList.add('hidden');
  }
}

function renderQuotas(models) {
  const container = document.getElementById('quotas-list');
  container.innerHTML = '';
  if (!models || !models.length) {
    container.innerHTML = '<div class="empty-state">暂无模型配额数据</div>';
    return;
  }

  for (const m of models) {
    const row = document.createElement('div');
    row.className = 'quota-row';
    const hasQuota = typeof m.remainingFraction === 'number';
    const pct = hasQuota ? Number((m.remainingFraction * 100).toFixed(1)) : null;
    const fillClass = pct == null ? 'fill-subtle' : pct <= 20 ? 'danger' : pct <= 50 ? 'warn' : '';
    row.innerHTML = `
      <div class="row-top">
        <span><strong>${esc(m.label)}</strong></span>
        <span class="mono">${pct != null ? `${pct}%` : '不可用'}</span>
      </div>
      <div class="progress-track progress-thin" style="margin:5px 0">
        <div class="progress-fill ${fillClass}" style="width:${pct ?? 0}%"></div>
      </div>
      <div class="row-sub">
        <span>窗口 ${fmtNum(m.contextLimit)} (压缩 ${fmtNum(m.compressionLimit)})</span>
        <span>重置: ${fmtReset(m.resetTime)}</span>
      </div>
    `;
    container.appendChild(row);
  }
}

function renderHistory(hist) {
  const tot = hist.totals;
  document.getElementById('hist-total').textContent = fmtNum(tot.allTokens);
  document.getElementById('hist-convs').textContent =
    `${tot.conversationsWithTokens} / ${tot.conversationsTotal} 个会话含计量`;
  document.getElementById('hist-cache').textContent = `${(tot.cacheHitRate * 100).toFixed(1)}%`;

  const dStats = hist.bySource?.Desktop;
  const cStats = hist.bySource?.CLI;
  document.getElementById('hist-sources').textContent =
    `Desktop ${fmtNum(dStats?.totalTokens || 0)} · CLI ${fmtNum(cStats?.totalTokens || 0)}`;

  const grid = document.getElementById('heatmap-grid');
  const tip = document.getElementById('heatmap-tip');
  grid.innerHTML = '';
  const max = hist.heatmap?.maxTokens || 0;

  for (const day of hist.heatmap?.days || []) {
    const cell = document.createElement('div');
    cell.className = 'heat-cell';
    let level = 0;
    if (day.totalTokens > 0 && max > 0) {
      const ratio = day.totalTokens / max;
      level = ratio > 0.75 ? 4 : ratio > 0.45 ? 3 : ratio > 0.18 ? 2 : 1;
    }
    cell.dataset.level = String(level);
    cell.title = `${day.date}: ${fmtNum(day.totalTokens)} tokens (${day.turns} 轮)`;
    cell.addEventListener('mouseenter', () => {
      tip.textContent = `${day.date} · 总 ${fmtNum(day.totalTokens)}（新 ${fmtNum(day.freshInput)} / 缓 ${fmtNum(day.cacheRead)} / 出 ${fmtNum(day.output)} · ${day.turns} 轮）`;
    });
    grid.appendChild(cell);
  }

  const bd = document.getElementById('history-breakdown');
  bd.innerHTML = '';
  for (const m of (hist.byModel || []).slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'breakdown-row';
    const prompt = m.freshInput + m.cacheRead;
    const hit = prompt > 0 ? ((m.cacheRead / prompt) * 100).toFixed(1) : '0.0';
    row.innerHTML = `
      <div class="row-top">
        <span><strong>${esc(m.model)}</strong></span>
        <span class="mono">${fmtNum(m.totalTokens)}</span>
      </div>
      <div class="row-sub mono">
        <span>${m.turns} 轮</span>
        <span>新:${fmtNum(m.freshInput)}</span>
        <span>缓:${fmtNum(m.cacheRead)} (${hit}%)</span>
        <span>出:${fmtNum(m.output)}</span>
      </div>
    `;
    bd.appendChild(row);
  }
}

async function loadOverview() {
  const errEl = document.getElementById('error-banner');
  const dotEl = document.getElementById('live-dot');
  try {
    const params = new URLSearchParams();
    if (state.followActive) {
      params.set('follow', '1');
    } else if (state.selectedConvId) {
      params.set('conversationId', state.selectedConvId);
    }
    params.set('turnsLimit', String(state.turnsLimit));
    const data = await apiFetch(`/api/overview?${params.toString()}`);
    errEl.classList.add('hidden');
    dotEl.classList.remove('error');

    const planBadge = document.getElementById('plan-badge');
    if (data.planName) {
      planBadge.textContent = data.planName;
      planBadge.classList.remove('hidden');
    }

    renderConversations(data.conversations || [], data.snapshot?.conversationId, data.hostConversationId);
    renderCompactBar(data.snapshot);
    renderContext(data.snapshot);
    renderQuotas(data.models);
  } catch (err) {
    dotEl.classList.add('error');
    errEl.textContent = `数据加载失败: ${err.message}`;
    errEl.classList.remove('hidden');
  }
}

async function loadHistory(force = false) {
  try {
    const data = await apiFetch(`/api/history${force ? '?force=1' : ''}`);
    state.historyLoaded = true;
    renderHistory(data);
  } catch (err) {
    const errEl = document.getElementById('error-banner');
    errEl.textContent = `历史扫描失败: ${err.message}`;
    errEl.classList.remove('hidden');
  }
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    state.activeTab = target;
    document.querySelectorAll('.tab').forEach((b) => {
      const on = b.dataset.tab === target;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('active', p.id === `panel-${target}`);
    });
    if (target === 'history' && !state.historyLoaded) {
      loadHistory(false);
    }
  });
});

document.getElementById('conv-select').addEventListener('change', (e) => {
  if (e.target.value === '__auto__') {
    state.followActive = true;
    state.selectedConvId = '';
  } else {
    state.followActive = false;
    state.selectedConvId = e.target.value;
  }
  state.turnsLimit = 20;
  loadOverview();
});

document.getElementById('collapse-btn').addEventListener('click', () => {
  state.collapsed = !state.collapsed;
  localStorage.setItem('cd_collapsed', String(state.collapsed));
  applyCollapseState();
});

document.getElementById('turns-more-btn').addEventListener('click', () => {
  state.turnsLimit = Math.min(200, state.turnsLimit + 20);
  loadOverview();
});

document.getElementById('turns-reset-btn').addEventListener('click', () => {
  state.turnsLimit = 20;
  loadOverview();
});

document.getElementById('refresh-btn').addEventListener('click', () => {
  const link = document.querySelector('link[rel="stylesheet"]');
  if (link) link.href = `/styles.css?v=${Date.now()}`;
  loadOverview();
  if (state.activeTab === 'history') loadHistory(true);
});

document.getElementById('hist-refresh-btn').addEventListener('click', () => loadHistory(true));

applyCollapseState();
loadOverview();
state.timer = setInterval(loadOverview, 5000);
