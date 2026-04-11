import * as k8s from '@kubernetes/client-node';
import { ContainerInfo } from '../types';
import { IRuntimeClient } from './runtime-client';
import { logger } from '../utils/logger';
import { getConfig } from '../utils/config';
import {
  parsePolicyFromLabel,
  parseAutoUpdateLabel,
  parseJSONLabel,
  parseIntervalLabel,
  parseGitAuthTypeLabel,
} from '../utils/label-parser';

export class KubernetesClient implements IRuntimeClient {
  private kc: k8s.KubeConfig;
  private coreV1Api: k8s.CoreV1Api;
  private appsV1Api: k8s.AppsV1Api;
  // Cache image digests gathered from pod status during getRunningContainers
  private imageDigestCache: Map<string, string> = new Map();

  constructor() {
    this.kc = new k8s.KubeConfig();
    const config = getConfig();

    if (config.kubernetes?.kubeconfigPath) {
      this.kc.loadFromFile(config.kubernetes.kubeconfigPath);
      logger.info(`☸️  Using kubeconfig: ${config.kubernetes.kubeconfigPath}`);
    } else {
      this.kc.loadFromDefault();
      logger.info('☸️  Using default Kubernetes configuration');
    }

    this.coreV1Api = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsV1Api = this.kc.makeApiClient(k8s.AppsV1Api);
    logger.info('☸️  Initialized Kubernetes client');
  }

  async ping(): Promise<boolean> {
    try {
      // Check API server reachability without depending on any specific namespace existing
      const versionApi = this.kc.makeApiClient(k8s.VersionApi);
      await versionApi.getCode();
      return true;
    } catch (error) {
      logger.error('❌ Failed to connect to Kubernetes API:', error);
      return false;
    }
  }

  async getRunningContainers(): Promise<ContainerInfo[]> {
    const config = getConfig();
    const k8sConfig = config.kubernetes;
    const containers: ContainerInfo[] = [];
    // Deduplicate: a Deployment with 3 replicas has 3 pods — only monitor/update once
    const seen = new Set<string>();

    try {
      let pods: k8s.V1Pod[] = [];

      if (k8sConfig?.allNamespaces) {
        const response = await this.coreV1Api.listPodForAllNamespaces();
        pods = response.items;
      } else {
        const namespaces = k8sConfig?.namespaces || ['default'];
        for (const ns of namespaces) {
          try {
            const response = await this.coreV1Api.listNamespacedPod({ namespace: ns });
            pods.push(...response.items);
          } catch (error) {
            logger.warn(`⚠️  Skipping namespace "${ns}": ${error instanceof Error ? error.message : error}`);
          }
        }
      }

      for (const pod of pods) {
        if (pod.status?.phase !== 'Running') continue;

        const namespace = pod.metadata?.namespace || 'default';
        // Merge pod labels and annotations; annotations take precedence for containrdog settings
        const podLabels = pod.metadata?.labels || {};
        const annotations = pod.metadata?.annotations || {};
        const allLabels = { ...podLabels, ...annotations };

        // Respect enabled/disabled label
        const labelValue = allLabels[config.label];
        if (labelValue === 'false') continue;
        if (config.labeledOnly && labelValue !== 'true') continue;

        // Find the owning workload (Deployment, StatefulSet, DaemonSet) for update operations
        const workload = await this.findOwningWorkload(pod, namespace);

        for (const containerSpec of pod.spec?.containers || []) {
          const image = containerSpec.image || '';

          // Extract digest from pod container status
          const containerStatus = pod.status?.containerStatuses?.find(
            (cs) => cs.name === containerSpec.name
          );
          const digest = this.extractDigest(containerStatus?.imageID);

          if (digest) {
            this.imageDigestCache.set(image, digest);
          }

          // Build a stable ID per workload+container to avoid duplicate entries
          const id = workload
            ? `${namespace}/${workload.kind}/${workload.name}/${containerSpec.name}`
            : `${namespace}/Pod/${pod.metadata?.name}/${containerSpec.name}`;

          if (seen.has(id)) continue;
          seen.add(id);

          containers.push({
            id,
            name: workload
              ? `${workload.name}/${containerSpec.name}`
              : `${pod.metadata?.name}/${containerSpec.name}`,
            image,
            imageId: digest || containerStatus?.imageID || '',
            labels: allLabels,
            created: pod.metadata?.creationTimestamp
              ? new Date(pod.metadata.creationTimestamp).getTime()
              : 0,
            policy: parsePolicyFromLabel(allLabels['containrdog.policy']),
            matchTag: allLabels['containrdog.match-tag'] === 'true',
            globPattern: allLabels['containrdog.glob-pattern'],
            autoUpdate: parseAutoUpdateLabel(allLabels['containrdog.auto-update']),
            imageLabelKey: allLabels['containrdog.image-label'] || undefined,
            updateCommands: parseJSONLabel(allLabels['containrdog.update-commands']),
            preUpdateCommands: parseJSONLabel(allLabels['containrdog.pre-update-commands']),
            postUpdateCommands: parseJSONLabel(allLabels['containrdog.post-update-commands']),
            gitopsEnabled: allLabels['containrdog.gitops-enabled'] === 'true' ? true : undefined,
            gitopsRepoUrl: allLabels['containrdog.gitops-repo-url'],
            gitopsBranch: allLabels['containrdog.gitops-branch'],
            gitopsAuthType: parseGitAuthTypeLabel(allLabels['containrdog.gitops-auth-type']),
            gitopsToken: allLabels['containrdog.gitops-token'],
            gitopsSshKeyPath: allLabels['containrdog.gitops-ssh-key-path'],
            gitopsPollInterval: parseIntervalLabel(allLabels['containrdog.gitops-poll-interval']),
            gitopsWatchPaths: parseJSONLabel(allLabels['containrdog.gitops-watch-paths']),
            gitopsCommands: parseJSONLabel(allLabels['containrdog.gitops-commands']),
            gitopsClonePath: allLabels['containrdog.gitops-clone-path'],
            gitopsQuietMode: allLabels['containrdog.gitops-quiet-mode'] === 'true' ? true : undefined,
            namespace,
            workloadKind: workload?.kind,
            workloadName: workload?.name,
            containerName: containerSpec.name,
          });
        }
      }
    } catch (error) {
      logger.error('❌ Failed to list Kubernetes pods:', error);
    }

    return containers;
  }

  async getImageDigest(imageName: string): Promise<string | undefined> {
    return this.imageDigestCache.get(imageName);
  }

  async updateContainerImage(containerId: string, newImageName: string): Promise<void> {
    // containerId format: namespace/workloadKind/workloadName/containerName
    const parts = containerId.split('/');
    if (parts.length < 4) {
      throw new Error(`Invalid Kubernetes container ID format: ${containerId}`);
    }

    const [namespace, workloadKind, workloadName, containerName] = parts;

    if (workloadKind === 'Pod') {
      logger.warn(`⚠️  Cannot auto-update standalone Pod ${workloadName}. Annotate the owning Deployment/StatefulSet/DaemonSet instead.`);
      return;
    }

    logger.info(`   ☸️  Patching ${workloadKind}/${workloadName} in ${namespace}: ${containerName} -> ${newImageName}`);

    // Strategic merge patch: Kubernetes merges by container name, so only the named container is updated
    const patch = {
      spec: {
        template: {
          spec: {
            containers: [{ name: containerName, image: newImageName }],
          },
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patchOptions: any = { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } };

    try {
      switch (workloadKind) {
        case 'Deployment':
          await this.appsV1Api.patchNamespacedDeployment(
            { name: workloadName, namespace, body: patch },
            patchOptions
          );
          break;
        case 'StatefulSet':
          await this.appsV1Api.patchNamespacedStatefulSet(
            { name: workloadName, namespace, body: patch },
            patchOptions
          );
          break;
        case 'DaemonSet':
          await this.appsV1Api.patchNamespacedDaemonSet(
            { name: workloadName, namespace, body: patch },
            patchOptions
          );
          break;
        default:
          throw new Error(`Unsupported workload kind for updates: ${workloadKind}`);
      }

      logger.info(`   ✅ Successfully patched ${workloadKind}/${workloadName}`);
    } catch (error) {
      logger.error(`   ❌ Failed to patch ${workloadKind}/${workloadName}:`, error);
      throw error;
    }
  }

  /**
   * Walk ownerReferences to find the top-level workload that owns a pod.
   * Pod -> ReplicaSet -> Deployment, or Pod -> StatefulSet/DaemonSet directly.
   */
  private async findOwningWorkload(
    pod: k8s.V1Pod,
    namespace: string
  ): Promise<{ kind: string; name: string } | null> {
    for (const ownerRef of pod.metadata?.ownerReferences || []) {
      if (ownerRef.kind === 'ReplicaSet') {
        try {
          const rs = await this.appsV1Api.readNamespacedReplicaSet({ name: ownerRef.name, namespace });
          for (const rsOwner of rs.metadata?.ownerReferences || []) {
            if (rsOwner.kind === 'Deployment') {
              return { kind: 'Deployment', name: rsOwner.name };
            }
          }
        } catch {
          // ReplicaSet not accessible; fall through
        }
      } else if (ownerRef.kind === 'StatefulSet' || ownerRef.kind === 'DaemonSet') {
        return { kind: ownerRef.kind, name: ownerRef.name };
      }
    }
    return null;
  }

  /**
   * Extract the sha256 digest from a Kubernetes imageID string.
   * e.g. "docker.io/library/nginx@sha256:abc123..." -> "sha256:abc123..."
   */
  private extractDigest(imageID?: string): string | undefined {
    if (!imageID) return undefined;
    const match = imageID.match(/@(sha256:[a-f0-9]+)/);
    return match ? match[1] : undefined;
  }
}
