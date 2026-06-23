import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// The dashboard HTML is read synchronously in the constructor — stub the fs read.
vi.mock('node:fs', () => ({ readFileSync: () => '<html>dashboard</html>' }));

vi.mock('../../../src/utils/config', () => ({
  getConfig: vi.fn(() => ({ runtime: 'docker', interval: 5000, policy: 'major' })),
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ApiServer } from '../../../src/services/api-server';
import { StatusStore } from '../../../src/services/status-store';
import { ComponentHealth } from '../../../src/types';

function stubMonitor() {
  return {
    triggerGlobalGitOps: vi.fn(async (mode: string, force: boolean) => ({
      scope: 'global', mode, forced: force, triggered: true, code: 'ok', affected: ['a', 'b'],
    })),
    triggerContainerGitOps: vi.fn(async (name: string, mode: string, force: boolean) => {
      if (name === 'ghost') return { scope: 'container', mode, forced: force, triggered: false, code: 'not_found', message: 'nope' };
      return { scope: 'container', mode, forced: force, triggered: true, code: 'ok', affected: [name] };
    }),
  };
}

describe('ApiServer GitOps trigger routes', () => {
  let server: Server;
  let base: string;
  let monitor: ReturnType<typeof stubMonitor>;

  beforeEach(async () => {
    vi.clearAllMocks();
    monitor = stubMonitor();
    // Port 0 → OS assigns a free port.
    server = new ApiServer(0, monitor as any).start();
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it('routes POST /api/gitops/trigger to the global trigger (defaults: run, force=false)', async () => {
    const res = await fetch(`${base}/api/gitops/trigger`, { method: 'POST' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(monitor.triggerGlobalGitOps).toHaveBeenCalledWith('run', false);
    expect(body).toMatchObject({ scope: 'global', triggered: true, affected: ['a', 'b'] });
  });

  it('parses mode and force query params', async () => {
    await fetch(`${base}/api/gitops/trigger?mode=check&force=true`, { method: 'POST' });
    expect(monitor.triggerGlobalGitOps).toHaveBeenCalledWith('check', true);
  });

  it('routes a path suffix to the per-container trigger', async () => {
    const res = await fetch(`${base}/api/gitops/trigger/web?mode=check`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(monitor.triggerContainerGitOps).toHaveBeenCalledWith('web', 'check', false);
  });

  it('decodes a Kubernetes-style name with slashes via ?container=', async () => {
    await fetch(`${base}/api/gitops/trigger?container=${encodeURIComponent('ns/web/app')}`, { method: 'POST' });
    expect(monitor.triggerContainerGitOps).toHaveBeenCalledWith('ns/web/app', 'run', false);
  });

  it('maps not_found to HTTP 404', async () => {
    const res = await fetch(`${base}/api/gitops/trigger/ghost`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('not_found');
  });

  it('rejects an invalid mode with HTTP 400 and does not call the monitor', async () => {
    const res = await fetch(`${base}/api/gitops/trigger?mode=bogus`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(monitor.triggerGlobalGitOps).not.toHaveBeenCalled();
  });

  it('does not treat GET on the trigger path as a trigger', async () => {
    const res = await fetch(`${base}/api/gitops/trigger`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(monitor.triggerGlobalGitOps).not.toHaveBeenCalled();
  });

  it('serves the API even when the UI is disabled', async () => {
    // The server in beforeEach was constructed with uiEnabled=false (default).
    const status = await fetch(`${base}/api/status`, { method: 'POST' });
    expect(status.status).toBe(404); // POST not allowed on status

    const dash = await fetch(`${base}/`, { method: 'GET' });
    expect(dash.status).toBe(404); // dashboard HTML not served when UI disabled

    const trigger = await fetch(`${base}/api/gitops/trigger`, { method: 'POST' });
    expect(trigger.status).toBe(200); // API/triggers still work
  });
});

describe('ApiServer UI gating', () => {
  let server: Server;
  let base: string;

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  async function startWith(uiEnabled: boolean) {
    server = new ApiServer(0, stubMonitor() as any, uiEnabled).start();
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  }

  it('serves the dashboard HTML at / when UI is enabled', async () => {
    await startWith(true);
    const res = await fetch(`${base}/`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('dashboard');
  });

  it('returns 404 at / when UI is disabled', async () => {
    await startWith(false);
    const res = await fetch(`${base}/`, { method: 'GET' });
    expect(res.status).toBe(404);
  });
});

describe('ApiServer /api/status component health', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    StatusStore.instance.setContainers([
      { id: 'a', name: 'web', image: 'nginx:1.0.0', imageId: 'sha256:1', labels: {}, created: 0, health: ComponentHealth.HEALTHY },
      { id: 'b', name: 'api', image: 'api:2.0.0', imageId: 'sha256:2', labels: {}, created: 0, health: ComponentHealth.DEGRADED, healthReason: 'CrashLoopBackOff' },
    ]);
    server = new ApiServer(0, stubMonitor() as any, false).start();
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it('exposes per-component health and sync in the status payload', async () => {
    const res = await fetch(`${base}/api/status`);
    const body = await res.json();
    const byName = Object.fromEntries(body.containers.map((c: any) => [c.name, c]));
    expect(byName.web.health).toBe('healthy');
    expect(byName.web.sync).toBe('synced');
    expect(byName.web.currentTag).toBe('1.0.0');
    expect(byName.api.health).toBe('degraded');
    expect(byName.api.healthReason).toBe('CrashLoopBackOff');
  });
});
