#!/usr/bin/env node

const DEFAULT_CONFIG = {
  hosts: 1000,
  sessions: 300,
  workspaces: 60,
  logs: 5000,
  iterations: 240,
  warmup: 20,
};

const toMs = (n) => Number(n.toFixed(3));

const percentile = (samples, p) => {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

const summarize = (name, samples) => {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const avg = samples.reduce((sum, n) => sum + n, 0) / samples.length;
  return { metric: name, p50: toMs(p50), p95: toMs(p95), avg: toMs(avg) };
};

const measure = (name, iterations, warmup, fn) => {
  for (let i = 0; i < warmup; i += 1) fn(i);
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  return summarize(name, samples);
};

const generateHosts = (count) =>
  Array.from({ length: count }, (_, idx) => ({
    id: `host-${idx}`,
    label: `Host-${idx}`,
    hostname: `10.0.${Math.floor(idx / 255)}.${idx % 255}`,
    username: 'root',
  }));

const generateSessions = (count, workspaceCount) =>
  Array.from({ length: count }, (_, idx) => {
    const workspaceId = idx % 5 === 0 ? undefined : `ws-${idx % workspaceCount}`;
    return {
      id: `session-${idx}`,
      hostId: `host-${idx % Math.max(1, count)}`,
      hostLabel: `Host-${idx}`,
      hostname: `srv-${idx}.example.com`,
      status: idx % 3 === 0 ? 'connected' : (idx % 3 === 1 ? 'connecting' : 'error'),
      workspaceId,
    };
  });

const generateWorkspaces = (count, sessions) =>
  Array.from({ length: count }, (_, idx) => ({
    id: `ws-${idx}`,
    title: `Workspace-${idx}`,
    sessionIds: sessions.filter((s) => s.workspaceId === `ws-${idx}`).map((s) => s.id),
  }));

const generateLogs = (count) =>
  Array.from({ length: count }, (_, idx) => ({
    id: `log-${idx}`,
    sessionId: `session-${idx % Math.max(1, count)}`,
    startTime: Date.now() - idx * 1000,
    saved: idx % 7 === 0,
  }));

const fingerprintForSync = (payload) =>
  [
    payload.hosts,
    payload.sessions,
    payload.workspaces,
    payload.logs,
    payload.settingsVersion,
    payload.bookmarksVersion,
  ]
    .map((part) => (Array.isArray(part) ? `arr:${part.length}` : String(part)))
    .join('|');

const run = () => {
  const config = { ...DEFAULT_CONFIG };
  const hosts = generateHosts(config.hosts);
  const sessions = generateSessions(config.sessions, config.workspaces);
  const workspaces = generateWorkspaces(config.workspaces, sessions);
  const logs = generateLogs(config.logs);
  const workspaceTitleById = new Map(workspaces.map((ws) => [ws.id, ws.title]));
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));

  const results = [];

  results.push(
    measure('tab_switch_lookup', config.iterations, config.warmup, (i) => {
      const tabId = i % 2 === 0 ? `session-${i % sessions.length}` : `ws-${i % workspaces.length}`;
      const session = sessionById.get(tabId);
      if (session) return session.status;
      const workspace = workspaceById.get(tabId);
      return workspace?.title;
    }),
  );

  results.push(
    measure('close_session_path', config.iterations, config.warmup, (i) => {
      const closeId = `session-${i % sessions.length}`;
      const nextSessions = sessions.filter((s) => s.id !== closeId);
      const orphan = nextSessions.find((s) => !s.workspaceId);
      return orphan?.id ?? 'vault';
    }),
  );

  results.push(
    measure('autosync_fingerprint', config.iterations, config.warmup, (i) => {
      return fingerprintForSync({
        hosts,
        sessions,
        workspaces,
        logs,
        settingsVersion: i,
        bookmarksVersion: i % 9,
      });
    }),
  );

  results.push(
    measure('tray_payload_build', config.iterations, config.warmup, () => {
      const sessionsForTray = sessions.map((session) => ({
        id: session.id,
        label: session.hostname,
        hostLabel: session.hostLabel,
        status: session.status,
        workspaceId: session.workspaceId,
        workspaceTitle: session.workspaceId ? workspaceTitleById.get(session.workspaceId) : undefined,
      }));
      return `${sessionsForTray.length}:${sessionsForTray[0]?.id ?? ''}`;
    }),
  );

  console.log('\n=== Netcatty Performance Baseline ===');
  console.log(`Dataset: hosts=${config.hosts}, sessions=${config.sessions}, workspaces=${config.workspaces}, logs=${config.logs}`);
  console.log(`Iterations: ${config.iterations} (warmup: ${config.warmup})\n`);
  console.table(results);
  console.log('\nSuggested regression gates:');
  console.log('- tab_switch_lookup p95 <= baseline * 1.30');
  console.log('- close_session_path p95 <= baseline * 1.30');
  console.log('- autosync_fingerprint p95 <= baseline * 1.50');
  console.log('- tray_payload_build p95 <= baseline * 1.30');
  console.log('');
};

run();
