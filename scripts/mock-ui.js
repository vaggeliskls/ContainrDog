#!/usr/bin/env node
// Run: node scripts/mock-ui.js
// Then open: http://localhost:8080
'use strict';

const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');

const PORT = 8080;
const HTML = fs.readFileSync(path.resolve(__dirname, '../src/ui/dashboard.html'), 'utf-8');

const now  = new Date();
const ago  = (ms) => new Date(now - ms).toISOString();

const STATUS = {
  startedAt:        ago(3 * 60 * 60 * 1000),
  lastCheckAt:      ago(45 * 1000),
  nextCheckAt:      new Date(now.getTime() + 255_000).toISOString(),
  checkInProgress:  false,
  config: {
    runtime:        'kubernetes',
    intervalMs:     300_000,
    policy:         'minor',
    autoUpdate:     true,
    labeledOnly:    true,
    label:          'containrdog-enabled',
    namespaces:     ['staging', 'production'],
    imageLabelKeys: ['org.opencontainers.image.revision', 'org.opencontainers.image.version'],
    webhookEnabled: true,
    webhookProvider:'slack',
    gitopsEnabled:  true,
    ecrEnabled:     false,
  },
  containers: [
    {
      id:            'pod-abc123',
      name:          'api-server',
      image:         'ghcr.io/myorg/api-server:1.4.2',
      namespace:     'production',
      workloadKind:  'Deployment',
      workloadName:  'api-server',
      containerName: 'api-server',
      autoUpdate:    true,
      policy:        'minor',
      imageLabelKeys:['org.opencontainers.image.revision'],
      gitops: {
        scope:                 'global',
        repoUrl:               'https://github.com/myorg/config-repo.git',
        branch:                'main',
        watchPaths:            ['k8s/**', 'config/*.yaml'],
        pollIntervalMs:        60_000,
        hasPerContainerCommands: false,
      },
    },
    {
      id:            'pod-def456',
      name:          'worker',
      image:         'ghcr.io/myorg/worker:sha-a1b2c3d',
      namespace:     'staging',
      workloadKind:  'Deployment',
      workloadName:  'worker',
      containerName: 'worker',
      autoUpdate:    false,
      policy:        'major',
      imageLabelKeys:[],
      gitops: {
        scope:                 'per-container',
        repoUrl:               'https://github.com/myorg/worker-config.git',
        branch:                'release',
        watchPaths:            ['deploy/staging/**'],
        pollIntervalMs:        120_000,
        hasPerContainerCommands: true,
      },
    },
    {
      id:            'pod-ghi789',
      name:          'cache',
      image:         'redis:7.2',
      namespace:     'staging',
      workloadKind:  'StatefulSet',
      workloadName:  'cache',
      containerName: 'redis',
      autoUpdate:    true,
      policy:        'patch',
      imageLabelKeys:[],
      gitops: {
        scope:                 'none',
        hasPerContainerCommands: false,
      },
    },
    {
      id:            'pod-jkl012',
      name:          'metrics-exporter',
      image:         'prom/node-exporter:latest',
      namespace:     'production',
      workloadKind:  'DaemonSet',
      workloadName:  'metrics-exporter',
      containerName: 'node-exporter',
      autoUpdate:    true,
      policy:        'major',
      imageLabelKeys:[],
      gitops: {
        scope:                 'global',
        repoUrl:               'https://github.com/myorg/config-repo.git',
        branch:                'main',
        watchPaths:            ['k8s/monitoring/**', 'config/prometheus.yaml', 'alerts/*.yaml'],
        pollIntervalMs:        60_000,
        hasPerContainerCommands: false,
      },
    },
  ],
  recentUpdates: [
    {
      timestamp:    ago(2 * 60 * 1000),
      containerName:'api-server',
      fromTag:      '1.4.1',
      toTag:        '1.4.2',
      updateType:   'semantic_version',
      autoUpdated:  true,
      success:      true,
      labelValues:  {
        'org.opencontainers.image.revision': 'a1b2c3d4e5f6',
        'org.opencontainers.image.version':  '1.4.2',
      },
    },
    {
      timestamp:    ago(18 * 60 * 1000),
      containerName:'worker',
      fromTag:      'sha-oldsha1',
      toTag:        'sha-a1b2c3d',
      updateType:   'digest_change',
      autoUpdated:  false,
      success:      false,
    },
    {
      timestamp:    ago(45 * 60 * 1000),
      containerName:'metrics-exporter',
      fromTag:      'latest',
      toTag:        'latest',
      updateType:   'static_tag',
      autoUpdated:  true,
      success:      true,
      labelValues:  {
        'org.opencontainers.image.revision': 'deadbeef',
      },
    },
    {
      timestamp:    ago(2 * 3600 * 1000),
      containerName:'cache',
      fromTag:      '7.1',
      toTag:        '7.2',
      updateType:   'semantic_version',
      autoUpdated:  true,
      success:      false,
      error:        'kubectl patch failed: connection refused — api server unreachable',
    },
  ],
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(STATUS));
  } else if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log('Mock UI server running at http://localhost:' + PORT);
  console.log('Edit STATUS in this file to test different states.');
  console.log('Edit src/ui/dashboard.html — the server reads it fresh on each restart.');
});
