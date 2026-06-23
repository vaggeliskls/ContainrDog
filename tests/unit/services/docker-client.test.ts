import { describe, it, expect, vi } from 'vitest';
import { DockerClient } from '../../../src/services/docker-client';

vi.mock('../../../src/utils/config', () => ({
  getConfig: vi.fn(() => ({
    socketPath: '/var/run/docker.sock',
    update: {
      healthCheckEnabled: true,
      healthCheckTimeout: 30_000,
      healthCheckInterval: 3_000,
      rollbackOnFailure: true,
      failureCooldown: 3_600_000,
    },
  })),
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Build a minimal ContainerInspectInfo-like object for evaluateHealth.
function inspect(state: Record<string, unknown>, restartCount = 0): any {
  return { State: state, RestartCount: restartCount };
}

describe('DockerClient.evaluateHealth', () => {
  const client = new DockerClient() as any;

  it('honours a passing Docker HEALTHCHECK', () => {
    expect(client.evaluateHealth(inspect({ Running: true, Status: 'running', Health: { Status: 'healthy' } }))).toBe('healthy');
  });

  it('honours a failing Docker HEALTHCHECK', () => {
    expect(client.evaluateHealth(inspect({ Running: true, Status: 'running', Health: { Status: 'unhealthy' } }))).toBe('unhealthy');
  });

  it('keeps waiting while a HEALTHCHECK is still starting', () => {
    expect(client.evaluateHealth(inspect({ Running: true, Status: 'running', Health: { Status: 'starting' } }))).toBe('pending');
  });

  it('treats an exited container with no healthcheck as unhealthy', () => {
    expect(client.evaluateHealth(inspect({ Running: false, Status: 'exited' }))).toBe('unhealthy');
  });

  it('treats a restart loop as unhealthy', () => {
    expect(client.evaluateHealth(inspect({ Running: false, Status: 'running', Restarting: true }))).toBe('unhealthy');
    expect(client.evaluateHealth(inspect({ Running: true, Status: 'running' }, 2))).toBe('unhealthy');
  });

  it('keeps observing a healthcheck-less container that is still running', () => {
    expect(client.evaluateHealth(inspect({ Running: true, Status: 'running' }, 0))).toBe('pending-no-healthcheck');
  });
});

describe('DockerClient.deriveHealth (dashboard)', () => {
  const client = new DockerClient() as any;

  it('reports healthy for a running container (passing or no healthcheck)', () => {
    expect(client.deriveHealth(inspect({ Running: true, Status: 'running', Health: { Status: 'healthy' } })).health).toBe('healthy');
    expect(client.deriveHealth(inspect({ Running: true, Status: 'running' })).health).toBe('healthy');
  });

  it('reports degraded for an unhealthy healthcheck, restart loop, or exit', () => {
    expect(client.deriveHealth(inspect({ Running: true, Status: 'running', Health: { Status: 'unhealthy' } })).health).toBe('degraded');
    expect(client.deriveHealth(inspect({ Running: false, Status: 'running', Restarting: true })).health).toBe('degraded');
    expect(client.deriveHealth(inspect({ Running: false, Status: 'exited' })).health).toBe('degraded');
    expect(client.deriveHealth(inspect({ Running: true, Status: 'running' }, 5)).health).toBe('degraded');
  });

  it('reports progressing while a healthcheck is starting', () => {
    expect(client.deriveHealth(inspect({ Running: true, Status: 'running', Health: { Status: 'starting' } })).health).toBe('progressing');
  });
});
