import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StatusStore } from './status-store';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { ContainerRuntime } from '../types';

export class ApiServer {
  private port: number;
  private html: string;

  constructor(port = 8080) {
    this.port = port;
    // __dirname is src/services/ in dev (ts-node) and dist/services/ in prod.
    // The build script copies src/ui/ → dist/ui/ so the relative path works in both.
    this.html = readFileSync(resolve(__dirname, '../ui/dashboard.html'), 'utf-8');
  }

  start(): void {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/api/status') {
        this.handleStatus(res);
      } else if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.html);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`⚠️  UI server: port ${this.port} already in use, dashboard unavailable`);
      } else {
        logger.error('❌ UI server error:', err);
      }
    });

    server.listen(this.port, () => {
      logger.info(`🖥️  Dashboard available at http://localhost:${this.port}`);
    });
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
