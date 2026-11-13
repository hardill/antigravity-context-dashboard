import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { LanguageServerClient } from './lib/ls-client.mjs';
import { scanLocalTokenHistory } from './lib/history-scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const app = new SidecarApp();
const ls = new LanguageServerClient();

app.page('/', () => new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
  contentType: 'text/html; charset=utf-8',
  headers: { 'Cache-Control': 'no-store' },
}));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), {
    contentType,
    headers: { 'Cache-Control': 'no-store' },
  }), 'GET');
}

app.api('/api/overview', async (data) => {
  const follow = data?.follow === '1' || data?.follow === 'true';
  const requestedId = typeof data?.conversationId === 'string' && ID_RE.test(data.conversationId)
    ? data.conversationId
    : '';
  const defaultId = typeof app.config.conversationId === 'string' && ID_RE.test(app.config.conversationId)
    ? app.config.conversationId
    : '';

  const [statusBundle, trajectories] = await Promise.all([
    ls.getStatusAndModels(),
    ls.getTrajectories(),
  ]);

  const turnsLimit = Math.max(1, Math.min(200, Number(data?.turnsLimit) || 20));
  const turnsOffset = Math.max(0, Number(data?.turnsOffset) || 0);

  const running = trajectories.find((t) => t.status === 'CASCADE_RUN_STATUS_RUNNING');
  const autoId = running?.id || trajectories[0]?.id || defaultId;
  const targetId = follow ? autoId : (requestedId || autoId);
  const snapshot = targetId
    ? await ls.getConversationSnapshot(targetId, statusBundle, trajectories, { turnsLimit, turnsOffset })
    : { empty: true, conversationId: null, planName: statusBundle.planName };

  return {
    updatedAt: new Date().toISOString(),
    hostConversationId: defaultId || null,
    planName: statusBundle.planName,
    models: statusBundle.models,
    conversations: trajectories.slice(0, 40).map((t) => ({
      id: t.id,
      summary: t.summary,
      stepCount: t.stepCount,
      status: t.status,
      lastModifiedTime: t.lastModifiedTime,
    })),
    snapshot,
  };
}, 'GET');

app.api('/api/history', (data) => {
  const force = data?.force === '1' || data?.force === 'true';
  return scanLocalTokenHistory({ force });
}, 'GET');

app.run();
