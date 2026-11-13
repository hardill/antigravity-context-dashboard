// 只读 Language Server Connect-RPC 客户端与当前会话上下文/耗时分析器。

const DEFAULT_MODEL_META = {
  // 来自 IDE 模型配置口径：物理上下文上限与 256K 压缩阈值分别展示
  M525: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 262_144, family: 'Gemini 4 Hydrogen' },
  M526: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 262_144, family: 'Gemini 4 Hydrogen' },
  M527: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 262_144, family: 'Gemini 4 Hydrogen' },
  M528: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 262_144, family: 'Gemini 4 Hydrogen' },
  M438: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 262_144, family: 'Gemini 4 Carbon' },
  M437: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 262_144, family: 'Gemini 4 Carbon' },
  M427: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 262_144, family: 'Gemini 4 Carbon' },
  M670: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 262_144, family: 'Gemini 4 Carbon' },
  M419: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 65_536, family: 'Gemini 4 Argon' },
  M418: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 65_536, family: 'Gemini 4 Argon' },
  M417: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 65_536, family: 'Gemini 4 Argon' },
  M320: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 65_536, family: 'Gemini 3.8 Flash' },
  M319: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 65_536, family: 'Gemini 3.8 Flash' },
  M318: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 65_536, family: 'Gemini 3.8 Flash' },
  M667: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 262_144, family: 'Orchestrator' },
  M668: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 262_144, family: 'Orchestrator' },
  M669: { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 65_536, family: 'Worker' },
  M400: { contextLimit: 1_000_000, compressionLimit: 256_000, maxOutput: 128_000, family: 'Claude Opus 5.5' },
  M401: { contextLimit: 1_000_000, compressionLimit: 256_000, maxOutput: 128_000, family: 'Claude Opus 5.5' },
  M402: { contextLimit: 1_000_000, compressionLimit: 256_000, maxOutput: 128_000, family: 'Claude Opus 5.5' },
  M403: { contextLimit: 1_000_000, compressionLimit: 256_000, maxOutput: 128_000, family: 'Claude Sonnet 5.5' },
  M404: { contextLimit: 1_000_000, compressionLimit: 256_000, maxOutput: 128_000, family: 'Claude Sonnet 5.5' },
  M405: { contextLimit: 1_000_000, compressionLimit: 256_000, maxOutput: 128_000, family: 'Claude Sonnet 5.5' },
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: {
    contextLimit: 131_072,
    compressionLimit: 80_000,
    maxOutput: 32_768,
    family: 'GPT-OSS 120B',
  },
};

function shortModelCode(rawId = '') {
  const m = /MODEL_PLACEHOLDER_(M\d+)/.exec(rawId);
  return m ? m[1] : rawId;
}

function resolveModelLimits(rawId = '', label = '') {
  const code = shortModelCode(rawId);
  if (DEFAULT_MODEL_META[code]) return DEFAULT_MODEL_META[code];
  if (DEFAULT_MODEL_META[rawId]) return DEFAULT_MODEL_META[rawId];
  if (/gpt-?oss/i.test(label) || /gpt_oss/i.test(rawId)) {
    return { contextLimit: 131_072, compressionLimit: 80_000, maxOutput: 32_768, family: 'GPT-OSS' };
  }
  if (/claude/i.test(label)) {
    return { contextLimit: 1_000_000, compressionLimit: 256_000, maxOutput: 128_000, family: 'Claude' };
  }
  return { contextLimit: 1_048_576, compressionLimit: 256_000, maxOutput: 65_536, family: 'Gemini' };
}

function summarizePlannerAction(plannerResponse) {
  if (!plannerResponse || typeof plannerResponse !== 'object') return '';
  const calls = Array.isArray(plannerResponse.toolCalls) ? plannerResponse.toolCalls : [];
  const counts = new Map();
  for (const tc of calls) {
    const name = tc?.name || 'tool';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const toolPart = counts.size > 0
    ? '工具: ' + [...counts.entries()].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(', ')
    : '';

  const rawText = plannerResponse.response || plannerResponse.modifiedResponse || '';
  const cleanText = String(rawText).replace(/\s+/g, ' ').trim();
  const textPart = cleanText
    ? `回复: ${cleanText.length > 64 ? `${cleanText.slice(0, 64)}…` : cleanText}`
    : '';

  if (toolPart && textPart) return `${toolPart} · ${textPart}`;
  return toolPart || textPart;
}

function parseIntSafe(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseTimeMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export class LanguageServerClient {
  #address;
  #csrfToken;

  constructor({ address = process.env.ANTIGRAVITY_LS_ADDRESS, csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN } = {}) {
    this.#address = address || '';
    this.#csrfToken = csrfToken || '';
  }

  get available() {
    return Boolean(this.#address && this.#csrfToken);
  }

  async #rpc(method, body = {}) {
    if (!this.available) {
      throw new Error('Language Server environment variables are not configured');
    }
    const res = await fetch(`http://${this.#address}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': this.#csrfToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`RPC ${method} failed with status ${res.status}`);
    }
    return res.json();
  }

  async getStatusAndModels() {
    const data = await this.#rpc('GetUserStatus', {});
    const us = data?.userStatus || {};
    const planName = us.planStatus?.planInfo?.planName || us.userTier?.name || '';
    const configs = Array.isArray(us.cascadeModelConfigData?.clientModelConfigs)
      ? us.cascadeModelConfigData.clientModelConfigs
      : [];

    const models = [];
    const byRawId = new Map();

    for (const cfg of configs) {
      const rawId = cfg?.modelOrAlias?.model || cfg?.modelId || '';
      const label = cfg?.label || rawId;
      const limits = resolveModelLimits(rawId, label);
      const remaining = typeof cfg?.quotaInfo?.remainingFraction === 'number'
        ? cfg.quotaInfo.remainingFraction
        : null;
      const item = {
        rawId,
        shortId: shortModelCode(rawId),
        modelId: cfg?.modelId || '',
        label,
        family: limits.family,
        contextLimit: limits.contextLimit,
        compressionLimit: limits.compressionLimit,
        maxOutput: limits.maxOutput,
        remainingFraction: remaining,
        resetTime: cfg?.quotaInfo?.resetTime || null,
      };
      models.push(item);
      if (rawId) byRawId.set(rawId, item);
      if (cfg?.modelId) byRawId.set(cfg.modelId, item);
    }

    return { planName, models, byRawId };
  }

  async getTrajectories() {
    const data = await this.#rpc('GetAllCascadeTrajectories', {});
    const summaries = data?.trajectorySummaries || {};
    const list = Object.entries(summaries).map(([id, info]) => ({
      id,
      summary: info?.summary || id.slice(0, 8),
      stepCount: parseIntSafe(info?.stepCount),
      status: info?.status || 'UNKNOWN',
      createdTime: info?.createdTime || null,
      lastModifiedTime: info?.lastModifiedTime || null,
      workspaces: (info?.workspaces || [])
        .map((w) => w?.workspaceFolderAbsoluteUri || '')
        .filter(Boolean),
    }));
    list.sort((a, b) => (Date.parse(b.lastModifiedTime || 0) || 0) - (Date.parse(a.lastModifiedTime || 0) || 0));
    return list;
  }

  async getConversationSnapshot(cascadeId, statusBundle = null, trajectoriesList = null, { turnsLimit = 20, turnsOffset = 0 } = {}) {
    const bundle = statusBundle || await this.getStatusAndModels();
    const trajectories = trajectoriesList || await this.getTrajectories();
    const trajInfo = trajectories.find((t) => t.id === cascadeId) || null;

    if (!cascadeId) {
      return { conversationId: null, trajectory: null, planName: bundle.planName, empty: true };
    }

    const totalSteps = trajInfo?.stepCount || 500;
    const stepResp = await this.#rpc('GetCascadeTrajectorySteps', {
      cascadeId,
      startIndex: 0,
      endIndex: Math.max(totalSteps, 500),
    });
    const steps = Array.isArray(stepResp?.steps) ? stepResp.steps : [];

    const turns = [];
    let totalFreshInput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;
    let totalOutput = 0;
    let totalThinking = 0;
    let totalResponse = 0;
    let compressionEvents = 0;
    let lastContextTokens = null;
    let latestModelRawId = '';
    let latestStepMeta = null;

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const meta = s?.metadata || {};
      if (meta.generatorModel) latestModelRawId = meta.generatorModel;

      if (s?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && meta.modelUsage) {
        const u = meta.modelUsage;
        const freshInput = parseIntSafe(u.inputTokens);
        const cacheRead = parseIntSafe(u.cacheReadTokens);
        const cacheCreation = parseIntSafe(u.cacheCreationTokens);
        const output = parseIntSafe(u.outputTokens);
        const thinking = parseIntSafe(u.thinkingOutputTokens);
        const response = parseIntSafe(u.responseOutputTokens);
        const contextTokens = freshInput + cacheRead + cacheCreation;

        // PLANNER_RESPONSE 中 startedAt 常与 completedAt 相同，真实请求起点为 createdAt，首字可见时间为 viewableAt
        const createdMs = parseTimeMs(meta.createdAt);
        const viewableMs = parseTimeMs(meta.viewableAt);
        const finishedMs = parseTimeMs(meta.finishedGeneratingAt) ?? parseTimeMs(meta.completedAt);
        const durationMs = createdMs && finishedMs && finishedMs > createdMs ? finishedMs - createdMs : null;
        const ttftMs = createdMs && viewableMs && viewableMs >= createdMs ? viewableMs - createdMs : null;
        const tps = durationMs && durationMs > 0 && output > 0
          ? Number((output / (durationMs / 1000)).toFixed(1))
          : null;

        let compressed = false;
        const deltaTokens = lastContextTokens !== null ? contextTokens - lastContextTokens : null;
        if (deltaTokens !== null && deltaTokens < -5000) {
          compressed = true;
          compressionEvents++;
        }
        lastContextTokens = contextTokens;

        totalFreshInput += freshInput;
        totalCacheRead += cacheRead;
        totalCacheCreation += cacheCreation;
        totalOutput += output;
        totalThinking += thinking;
        totalResponse += response;

        const rawModel = u.model || meta.generatorModel || latestModelRawId;
        if (rawModel) latestModelRawId = rawModel;
        const modelInfo = bundle.byRawId.get(rawModel);

        const turn = {
          stepIndex: i,
          modelRawId: rawModel,
          modelLabel: modelInfo?.label || shortModelCode(rawModel) || 'Unknown',
          freshInput,
          cacheRead,
          cacheCreation,
          contextTokens,
          deltaTokens,
          actionSummary: summarizePlannerAction(s.plannerResponse),
          output,
          thinking,
          response,
          cacheHitRate: contextTokens > 0 ? Number((cacheRead / contextTokens).toFixed(4)) : 0,
          durationMs,
          ttftMs,
          tokensPerSec: tps,
          compressed,
          createdAt: meta.createdAt || null,
          finishedAt: meta.finishedGeneratingAt || meta.completedAt || null,
        };
        turns.push(turn);
        latestStepMeta = turn;
      }
    }

    const activeModelInfo = bundle.byRawId.get(latestModelRawId) || {
      rawId: latestModelRawId,
      shortId: shortModelCode(latestModelRawId),
      label: shortModelCode(latestModelRawId) || 'Unknown Model',
      ...resolveModelLimits(latestModelRawId, ''),
    };

    const currentContext = latestStepMeta ? latestStepMeta.contextTokens : 0;
    const compressionLimit = activeModelInfo.compressionLimit || 256_000;
    const modelContextLimit = activeModelInfo.contextLimit || 1_048_576;

    const totalPromptTokens = totalFreshInput + totalCacheRead + totalCacheCreation;
    const avgCacheHitRate = totalPromptTokens > 0
      ? Number((totalCacheRead / totalPromptTokens).toFixed(4))
      : 0;

    const turnsDesc = [...turns].reverse();
    const safeOffset = Math.max(0, Number(turnsOffset) || 0);
    const safeLimit = Math.max(1, Math.min(200, Number(turnsLimit) || 20));
    const pagedTurns = turnsDesc.slice(safeOffset, safeOffset + safeLimit);

    return {
      empty: false,
      conversationId: cascadeId,
      planName: bundle.planName,
      trajectory: trajInfo
        ? {
            summary: trajInfo.summary,
            status: trajInfo.status,
            stepCount: trajInfo.stepCount,
            loadedSteps: steps.length,
            lastModifiedTime: trajInfo.lastModifiedTime,
          }
        : {
            summary: cascadeId.slice(0, 8),
            status: 'UNKNOWN',
            stepCount: steps.length,
            loadedSteps: steps.length,
            lastModifiedTime: null,
          },
      activeModel: {
        rawId: activeModelInfo.rawId,
        shortId: activeModelInfo.shortId,
        label: activeModelInfo.label,
        contextLimit: modelContextLimit,
        compressionLimit,
        maxOutput: activeModelInfo.maxOutput,
        remainingFraction: activeModelInfo.remainingFraction ?? null,
        resetTime: activeModelInfo.resetTime ?? null,
      },
      context: {
        currentTokens: currentContext,
        freshInput: latestStepMeta?.freshInput || 0,
        cacheRead: latestStepMeta?.cacheRead || 0,
        cacheCreation: latestStepMeta?.cacheCreation || 0,
        lastOutput: latestStepMeta?.output || 0,
        compressionLimit,
        modelContextLimit,
        compressionPct: Number(((currentContext / compressionLimit) * 100).toFixed(2)),
        modelPct: Number(((currentContext / modelContextLimit) * 100).toFixed(2)),
        compressionEvents,
        justCompressed: Boolean(latestStepMeta?.compressed),
      },
      speed: {
        lastDurationMs: latestStepMeta?.durationMs ?? null,
        lastTtftMs: latestStepMeta?.ttftMs ?? null,
        lastTokensPerSec: latestStepMeta?.tokensPerSec ?? null,
        avgTokensPerSec: (() => {
          const valid = turns.filter((t) => t.durationMs && t.durationMs > 0 && t.output > 0);
          if (!valid.length) return null;
          const sumOut = valid.reduce((a, b) => a + b.output, 0);
          const sumMs = valid.reduce((a, b) => a + b.durationMs, 0);
          return sumMs > 0 ? Number((sumOut / (sumMs / 1000)).toFixed(1)) : null;
        })(),
      },
      totals: {
        apiCalls: turns.length,
        freshInput: totalFreshInput,
        cacheRead: totalCacheRead,
        cacheCreation: totalCacheCreation,
        output: totalOutput,
        thinking: totalThinking,
        response: totalResponse,
        allTokens: totalFreshInput + totalCacheRead + totalCacheCreation + totalOutput,
        avgCacheHitRate,
      },
      recentTurns: pagedTurns,
      turnsPagination: {
        total: turnsDesc.length,
        offset: safeOffset,
        limit: safeLimit,
        showing: pagedTurns.length,
        hasMore: safeOffset + pagedTurns.length < turnsDesc.length,
      },
    };
  }
}
