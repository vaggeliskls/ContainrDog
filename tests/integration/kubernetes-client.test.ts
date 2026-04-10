/**
 * Integration tests for KubernetesClient.
 *
 * Prerequisites: k3d + kubectl installed, cluster will be created/destroyed automatically.
 * Enable with: INTEGRATION_TESTS=true npx vitest run tests/integration/kubernetes-client.test.ts
 *
 * The test creates a k3d cluster, deploys a workload with containrdog annotations,
 * then verifies the client can list and patch it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { KubernetesClient } from '../../src/services/kubernetes-client';

const RUN = process.env.INTEGRATION_TESTS === 'true';

const CLUSTER_NAME = 'containrdog-integration';
const NAMESPACE = 'default';
const DEPLOYMENT_NAME = 'nginx-test';
const TEST_IMAGE_V1 = 'nginx:1.25-alpine';
const TEST_IMAGE_V2 = 'nginx:1.26-alpine';

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

describe.runIf(RUN)('KubernetesClient integration', () => {
  beforeAll(async () => {
    // Create cluster
    run(`k3d cluster create ${CLUSTER_NAME} --wait`);

    // Deploy test workload with containrdog annotation
    run(`kubectl create deployment ${DEPLOYMENT_NAME} --image=${TEST_IMAGE_V1} --namespace=${NAMESPACE}`);
    run(
      `kubectl annotate deployment ${DEPLOYMENT_NAME} containrdog-enabled=true --namespace=${NAMESPACE}`
    );
    // Wait for rollout
    run(`kubectl rollout status deployment/${DEPLOYMENT_NAME} --namespace=${NAMESPACE} --timeout=60s`);
  }, 120_000);

  afterAll(() => {
    try {
      run(`k3d cluster delete ${CLUSTER_NAME}`);
    } catch {}
  }, 60_000);

  it('ping() returns true when cluster is reachable', async () => {
    const client = new KubernetesClient({ namespaces: [NAMESPACE], allNamespaces: false });
    expect(await client.ping()).toBe(true);
  });

  it('getRunningContainers() finds the annotated deployment', async () => {
    const client = new KubernetesClient({ namespaces: [NAMESPACE], allNamespaces: false });
    const containers = await client.getRunningContainers();

    const found = containers.find(
      (c) => c.workloadName === DEPLOYMENT_NAME && c.namespace === NAMESPACE
    );
    expect(found).toBeDefined();
    expect(found!.image).toContain('nginx');
  });

  it('getRunningContainers() deduplicates replicas', async () => {
    // Scale to 3 replicas — should still return 1 ContainerInfo per workload
    run(`kubectl scale deployment ${DEPLOYMENT_NAME} --replicas=3 --namespace=${NAMESPACE}`);
    run(`kubectl rollout status deployment/${DEPLOYMENT_NAME} --namespace=${NAMESPACE} --timeout=60s`);

    const client = new KubernetesClient({ namespaces: [NAMESPACE], allNamespaces: false });
    const containers = await client.getRunningContainers();

    const entries = containers.filter((c) => c.workloadName === DEPLOYMENT_NAME);
    expect(entries).toHaveLength(1); // deduplicated

    // Reset
    run(`kubectl scale deployment ${DEPLOYMENT_NAME} --replicas=1 --namespace=${NAMESPACE}`);
  }, 90_000);

  it('updateContainerImage() patches the deployment to a new image', async () => {
    const client = new KubernetesClient({ namespaces: [NAMESPACE], allNamespaces: false });
    const containers = await client.getRunningContainers();
    const target = containers.find((c) => c.workloadName === DEPLOYMENT_NAME)!;
    expect(target).toBeDefined();

    await client.updateContainerImage(target.id, TEST_IMAGE_V2);
    run(`kubectl rollout status deployment/${DEPLOYMENT_NAME} --namespace=${NAMESPACE} --timeout=60s`);

    // Verify the deployment image was updated
    const image = run(
      `kubectl get deployment ${DEPLOYMENT_NAME} -n ${NAMESPACE} -o jsonpath='{.spec.template.spec.containers[0].image}'`
    ).trim();
    expect(image).toBe(TEST_IMAGE_V2);
  }, 90_000);

  it('ping() returns false for a non-existent cluster context', async () => {
    const client = new KubernetesClient({
      namespaces: ['default'],
      allNamespaces: false,
      kubeconfigPath: '/nonexistent/kubeconfig',
    });
    const result = await client.ping();
    expect(result).toBe(false);
  });

  it('getRunningContainers() skips missing namespaces gracefully', async () => {
    const client = new KubernetesClient({
      namespaces: [NAMESPACE, 'nonexistent-ns'],
      allNamespaces: false,
    });
    // Should not throw, nonexistent-ns is logged as warning
    const containers = await client.getRunningContainers();
    expect(Array.isArray(containers)).toBe(true);
  });
});

describe.skipIf(RUN)('KubernetesClient integration (skipped)', () => {
  it('set INTEGRATION_TESTS=true to run these tests', () => {
    expect(true).toBe(true);
  });
});
