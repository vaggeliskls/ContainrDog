import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StatusStore } from './status-store';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { ContainerRuntime } from '../types';
import { GitOpsTriggerCode, GitOpsTriggerMode, MonitorService } from './monitor-service';

const TRIGGER_PREFIX = '/api/gitops/trigger';

// Map a trigger outcome to an HTTP status code.
const STATUS_BY_CODE: Record<GitOpsTriggerCode, number> = {
  ok: 200,
  noop: 200,
  busy: 409,
  disabled: 409,
  not_found: 404,
  error: 500,
};

export class ApiServer {
  private port: number;
  private monitor?: MonitorService;
  private uiEnabled: boolean;
  // The dashboard HTML is only loaded when the UI is enabled; the HTTP API
  // (status + GitOps triggers) runs regardless.
  private html: string | null = null;

  constructor(port = 8080, monitor?: MonitorService, uiEnabled = false) {
    this.port = port;
    this.monitor = monitor;
    this.uiEnabled = uiEnabled;
    if (uiEnabled) {
      // __dirname is src/services/ in dev (ts-node) and dist/services/ in prod.
      // The build script copies src/ui/ → dist/ui/ so the relative path works in both.
      this.html = readFileSync(resolve(__dirname, '../ui/dashboard.html'), 'utf-8');
    }
  }

  start(): Server {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/api/status') {
        this.handleStatus(res);
      } else if (req.method === 'POST' && (path === TRIGGER_PREFIX || path.startsWith(`${TRIGGER_PREFIX}/`))) {
        this.handleGitOpsTrigger(url, path, res).catch((err: unknown) => {
          logger.error('❌ GitOps trigger handler error:', err);
          this.sendJson(res, 500, { triggered: false, code: 'error', message: String(err) });
        });
      } else if (req.method === 'GET' && (path === '/' || path === '')) {
        // The dashboard page is only served when the UI is enabled.
        if (this.uiEnabled && this.html) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.html);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Dashboard UI is disabled (set UI_ENABLED=true to serve it)');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`⚠️  HTTP API server: port ${this.port} already in use, API/dashboard unavailable`);
      } else {
        logger.error('❌ HTTP API server error:', err);
      }
    });

    server.listen(this.port, () => {
      if (this.uiEnabled) {
        logger.info(`🖥️  Dashboard + HTTP API available at http://localhost:${this.port}`);
      } else {
        logger.info(`🌐 HTTP API available at http://localhost:${this.port} (dashboard UI disabled)`);
      }
    });

    return server;
  }

  /**
   * POST /api/gitops/trigger            → trigger the global GitOps process
   * POST /api/gitops/trigger/<name>     → trigger a single container/deployment
   * POST /api/gitops/trigger?container=<name>  (alternative; handles names with '/')
   *
   * Query params: ?mode=run|check (default run), ?force=true|false (default false).
   */
  private async handleGitOpsTrigger(url: URL, path: string, res: ServerResponse): Promise<void> {
    if (!this.monitor) {
      this.sendJson(res, 503, { triggered: false, code: 'error', message: 'Monitor service unavailable' });
      return;
    }

    const modeParam = (url.searchParams.get('mode') || 'run').toLowerCase();
    if (modeParam !== 'run' && modeParam !== 'check') {
      this.sendJson(res, 400, { triggered: false, code: 'error', message: `Invalid mode '${modeParam}'; expected 'run' or 'check'` });
      return;
    }
    const mode = modeParam as GitOpsTriggerMode;
    const force = url.searchParams.get('force') === 'true';

    // Container name from the path suffix or the ?container= query param. The
    // query param is preferred for Kubernetes names that contain '/'.
    let containerName = url.searchParams.get('container') || undefined;
    if (!containerName && path.startsWith(`${TRIGGER_PREFIX}/`)) {
      containerName = decodeURIComponent(path.slice(TRIGGER_PREFIX.length + 1));
    }

    const result = containerName
      ? await this.monitor.triggerContainerGitOps(containerName, mode, force)
      : await this.monitor.triggerGlobalGitOps(mode, force);

    this.sendJson(res, STATUS_BY_CODE[result.code] ?? 200, result);
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(payload));
  }

  private handleStatus(res: ServerResponse): void {
    const config = getConfig();
    const snap = StatusStore.instance.getSnapshot();

    const nextCheckAt = snap.lastCheckAt
      ? new Date(new Date(snap.lastCheckAt).getTime() + config.interval).toISOString()
      : null;

    const payload = {
      ...snap,
      nextCheckAt,
      config: {
        runtime: config.runtime,
        intervalMs: config.interval,
        policy: config.policy,
        autoUpdate: config.autoUpdate,
        labeledOnly: config.labeledOnly,
        label: config.label,
        namespaces:
          config.runtime === ContainerRuntime.KUBERNETES
            ? config.kubernetes?.allNamespaces
              ? ['all']
              : config.kubernetes?.namespaces
            : undefined,
        imageLabelKeys: config.imageLabelKeys,
        webhookEnabled: !!config.webhook?.enabled,
        webhookProvider: config.webhook?.provider,
        gitopsEnabled: !!config.gitops?.enabled,
        ecrEnabled: !!config.ecr?.enabled,
      },
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(payload));
  }
}
