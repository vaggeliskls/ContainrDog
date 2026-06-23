import * as k8s from '@kubernetes/client-node';
import { ComponentHealth, ContainerInfo } from '../types';
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

      // Track workloads we've already logged as mid-rollout this cycle so we
      // don't spam the log once per pod.
      const loggedUnstable = new Set<string>();

      for (const pod of pods) {
        if (pod.status?.phase !== 'Running') continue;
        // Skip pods being terminated. They stay phase=Running until the
        // container exits (up to terminationGracePeriodSeconds), but k8s has
        // already dropped them from Deployment.status.replicas — so the
        // workload-stability check below sees the rollout as settled while
        // the old pod is still here serving the previous digest. Without
        // this skip, the old pod's digest overwrites imageDigestCache and
        // we re-detect the same diff on the next poll.
        if (pod.metadata?.deletionTimestamp) continue;

        const namespace = pod.metadata?.namespace || 'default';

        // Find the owning workload (Deployment, StatefulSet, DaemonSet) for update operations
        const workload = await this.findOwningWorkload(pod, namespace);

        // Skip pods whose owning workload is mid-rollout. During a rolling
        // update, old pods stay phase=Running with the previous digest until
        // the new one is Ready — without this, every poll cycle that overlaps
        // the rollout re-detects the same digest diff and re-patches/notifies.
        if (workload && workload.stable === false) {
          const key = `${namespace}/${workload.kind}/${workload.name}`;
          if (!loggedUnstable.has(key)) {
            loggedUnstable.add(key);
            logger.debug(`⏳ Skipping ${workload.kind}/${workload.name} in ${namespace}: rollout in progress`);
          }
          continue;
        }

        // Merge in priority order (lowest -> highest): pod labels, pod annotations, workload annotations
        // Workload (Deployment/StatefulSet/DaemonSet) root-level annotations take the highest precedence,
        // allowing containrdog to be configured at the workload level without touching pod templates.
        const podLabels = pod.metadata?.labels || {};
        const podAnnotations = pod.metadata?.annotations || {};
        const workloadAnnotations = workload?.annotations || {};
        const allLabels = { ...podLabels, ...podAnnotations, ...workloadAnnotations };

        // Respect enabled/disabled label
        const labelValue = allLabels[config.label];
        if (labelValue === 'false') continue;
        if (config.labeledOnly && labelValue !== 'true') continue;

        // Only monitor regular containers — init containers are excluded
        for (const containerSpec of pod.spec?.containers || []) {
          const image = containerSpec.image || '';

          // Extract digest from pod container status
          const containerStatus = pod.status?.containerStatuses?.find(
            (cs) => cs.name === containerSpec.name
          );
          const digest = this.extractDigest(containerStatus?.imageID);
          const { health, healthReason } = this.deriveHealth(containerStatus, workload);

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
            globPattern: allLabels['containrdog.glob-pattern'],
            autoUpdate: parseAutoUpdateLabel(allLabels['containrdog.auto-update']),
            imageLabelKeys: parseJSONLabel(allLabels['containrdog.image-label']),
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
            health,
            healthReason,
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

    // Capture the current image for this container BEFORE patching, so we can
    // roll the workload back to it if the new image fails to roll out.
    const previousImage = await this.getWorkloadContainerImage(
      workloadKind,
      workloadName,
      namespace,
      containerName
    );

    logger.info(`   ☸️  Patching ${workloadKind}/${workloadName} in ${namespace}: ${containerName} -> ${newImageName}`);
    await this.patchWorkloadImage(workloadKind, workloadName, namespace, containerName, newImageName);
    logger.info(`   ✅ Successfully patched ${workloadKind}/${workloadName}`);

    const cfg = getConfig().update;
    if (!cfg.healthCheckEnabled) {
      return;
    }

    logger.info(`   🩺 Waiting for rollout (up to ${Math.round(cfg.healthCheckTimeout / 1000)}s)...`);
    const healthy = await this.waitForRolloutStable(
      workloadKind,
      workloadName,
      namespace,
      cfg.healthCheckTimeout,
      cfg.healthCheckInterval
    );

    if (healthy) {
      logger.info(`   ✅ Rollout of ${workloadKind}/${workloadName} to ${newImageName} is ready`);
      return;
    }

    logger.error(`   ❌ Rollout of ${workloadKind}/${workloadName} to ${newImageName} did not become ready`);

    if (!cfg.rollbackOnFailure || !previousImage) {
      if (!previousImage) {
        logger.warn(`   ⚠️  Could not determine previous image; cannot roll back ${workloadKind}/${workloadName}`);
      }
      throw new Error(`Rollout of ${newImageName} to ${workloadKind}/${workloadName} did not become ready`);
    }

    logger.warn(`   ↩️  Rolling back ${workloadKind}/${workloadName} to ${previousImage}...`);
    try {
      await this.patchWorkloadImage(workloadKind, workloadName, namespace, containerName, previousImage);
    } catch (rollbackError) {
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(
        `Rollout of ${newImageName} to ${workloadKind}/${workloadName} failed AND rollback to ${previousImage} failed: ${detail}`
      );
    }

    logger.info(`   ✅ Rolled back ${workloadKind}/${workloadName} to ${previousImage}`);
    throw new Error(
      `Rollout of ${newImageName} to ${workloadKind}/${workloadName} did not become ready; rolled back to ${previousImage}`
    );
  }

  /**
   * Apply a strategic merge patch that sets the image of a single named
   * container in the workload's pod template (and bumps restartedAt so the
   * rollout always re-triggers, even for a same-tag digest change).
   */
  private async patchWorkloadImage(
    workloadKind: string,
    workloadName: string,
    namespace: string,
    containerName: string,
    image: string
  ): Promise<void> {
    const patch = {
      spec: {
        template: {
          metadata: {
            annotations: {
              'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
            },
          },
          spec: {
            containers: [{ name: containerName, image }],
          },
        },
      },
    };
    const patchOptions = k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.StrategicMergePatch);

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
    } catch (error) {
      logger.error(`   ❌ Failed to patch ${workloadKind}/${workloadName}:`, error);
      throw error;
    }
  }

  /**
   * Read the current image of a named container from a workload's pod template.
   * Used to remember the rollback target before patching.
   */
  private async getWorkloadContainerImage(
    workloadKind: string,
    workloadName: string,
    namespace: string,
    containerName: string
  ): Promise<string | undefined> {
    try {
      let containers: k8s.V1Container[] | undefined;
      switch (workloadKind) {
        case 'Deployment':
          containers = (await this.appsV1Api.readNamespacedDeployment({ name: workloadName, namespace }))
            .spec?.template?.spec?.containers;
          break;
        case 'StatefulSet':
          containers = (await this.appsV1Api.readNamespacedStatefulSet({ name: workloadName, namespace }))
            .spec?.template?.spec?.containers;
          break;
        case 'DaemonSet':
          containers = (await this.appsV1Api.readNamespacedDaemonSet({ name: workloadName, namespace }))
            .spec?.template?.spec?.containers;
          break;
        default:
          return undefined;
      }
      return containers?.find((c) => c.name === containerName)?.image;
    } catch (error) {
      logger.warn(`⚠️  Could not read current image for ${workloadKind}/${workloadName}: ${error}`);
      return undefined;
    }
  }

  /**
   * Poll the workload until its rollout is settled (new revision fully updated,
   * ready, and nothing unavailable) or the timeout elapses. Reuses the same
   * stability predicates as the mid-rollout skip in getRunningContainers().
   */
  private async waitForRolloutStable(
    workloadKind: string,
    workloadName: string,
    namespace: string,
    timeoutMs: number,
    intervalMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        switch (workloadKind) {
          case 'Deployment': {
            const d = await this.appsV1Api.readNamespacedDeployment({ name: workloadName, namespace });
            if (this.isDeploymentStable(d)) return true;
            break;
          }
          case 'StatefulSet': {
            const s = await this.appsV1Api.readNamespacedStatefulSet({ name: workloadName, namespace });
            if (this.isStatefulSetStable(s)) return true;
            break;
          }
          case 'DaemonSet': {
            const ds = await this.appsV1Api.readNamespacedDaemonSet({ name: workloadName, namespace });
            if (this.isDaemonSetStable(ds)) return true;
            break;
          }
          default:
            return true; // Unknown kind — don't block on health we can't assess.
        }
      } catch (error) {
        logger.debug(`Rollout health read failed (will retry): ${error}`);
      }
      await this.sleep(intervalMs);
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Walk ownerReferences to find the top-level workload that owns a pod.
   * Pod -> ReplicaSet -> Deployment, or Pod -> StatefulSet/DaemonSet directly.
   * Also returns the workload's own annotations so they can be merged with pod annotations.
   */
  private async findOwningWorkload(
    pod: k8s.V1Pod,
    namespace: string
  ): Promise<{
    kind: string;
    name: string;
    annotations: Record<string, string>;
    // false = rollout in progress; true = settled; undefined = unknown (read failed)
    stable?: boolean;
  } | null> {
    for (const ownerRef of pod.metadata?.ownerReferences || []) {
      if (ownerRef.kind === 'ReplicaSet') {
        try {
          const rs = await this.appsV1Api.readNamespacedReplicaSet({ name: ownerRef.name, namespace });
          for (const rsOwner of rs.metadata?.ownerReferences || []) {
            if (rsOwner.kind === 'Deployment') {
              try {
                const deployment = await this.appsV1Api.readNamespacedDeployment({ name: rsOwner.name, namespace });
                return {
                  kind: 'Deployment',
                  name: rsOwner.name,
                  annotations: deployment.metadata?.annotations || {},
                  stable: this.isDeploymentStable(deployment),
                };
              } catch {
                return { kind: 'Deployment', name: rsOwner.name, annotations: {} };
              }
            }
          }
        } catch {
          // ReplicaSet not accessible; fall through
        }
      } else if (ownerRef.kind === 'StatefulSet') {
        try {
          const ss = await this.appsV1Api.readNamespacedStatefulSet({ name: ownerRef.name, namespace });
          return {
            kind: 'StatefulSet',
            name: ownerRef.name,
            annotations: ss.metadata?.annotations || {},
            stable: this.isStatefulSetStable(ss),
          };
        } catch {
          return { kind: 'StatefulSet', name: ownerRef.name, annotations: {} };
        }
      } else if (ownerRef.kind === 'DaemonSet') {
        try {
          const ds = await this.appsV1Api.readNamespacedDaemonSet({ name: ownerRef.name, namespace });
          return {
            kind: 'DaemonSet',
            name: ownerRef.name,
            annotations: ds.metadata?.annotations || {},
            stable: this.isDaemonSetStable(ds),
          };
        } catch {
          return { kind: 'DaemonSet', name: ownerRef.name, annotations: {} };
        }
      }
    }
    return null;
  }

  // Rollout settled when: controller has observed the latest spec generation,
  // every desired replica is updated and ready, and nothing is unavailable.
  // When fields are missing we lean toward "stable" so a partially-populated
  // status never blocks updates indefinitely.
  private isDeploymentStable(d: k8s.V1Deployment): boolean {
    const spec = d.spec;
    const status = d.status;
    if (!spec || !status) return true;
    const desired = spec.replicas ?? 1;
    if ((status.observedGeneration ?? 0) < (d.metadata?.generation ?? 0)) return false;
    if ((status.updatedReplicas ?? 0) !== desired) return false;
    if ((status.replicas ?? 0) !== desired) return false;
    if ((status.unavailableReplicas ?? 0) > 0) return false;
    return true;
  }

  private isStatefulSetStable(s: k8s.V1StatefulSet): boolean {
    const spec = s.spec;
    const status = s.status;
    if (!spec || !status) return true;
    const desired = spec.replicas ?? 1;
    if ((status.observedGeneration ?? 0) < (s.metadata?.generation ?? 0)) return false;
    if ((status.updatedReplicas ?? 0) !== desired) return false;
    if ((status.readyReplicas ?? 0) !== desired) return false;
    if (status.currentRevision && status.updateRevision && status.currentRevision !== status.updateRevision) return false;
    return true;
  }

  private isDaemonSetStable(d: k8s.V1DaemonSet): boolean {
    const status = d.status;
    if (!status) return true;
    if ((status.observedGeneration ?? 0) < (d.metadata?.generation ?? 0)) return false;
    if ((status.updatedNumberScheduled ?? 0) !== (status.desiredNumberScheduled ?? 0)) return false;
    if ((status.numberUnavailable ?? 0) > 0) return false;
    return true;
  }

  /**
   * Derive dashboard health for a pod's container from its status and the
   * owning workload's rollout state. Note: pods whose workload is mid-rollout
   * are filtered out upstream, so this mostly classifies settled pods.
   */
  private deriveHealth(
    cs: k8s.V1ContainerStatus | undefined,
    workload: { stable?: boolean } | null
  ): { health: ComponentHealth; healthReason?: string } {
    // A waiting container surfaces the most actionable signal (image pull /
    // crash loop errors), so check it before readiness.
    const waitingReason = cs?.state?.waiting?.reason;
    if (waitingReason) {
      const degradedReasons = ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerError', 'CreateContainerConfigError', 'InvalidImageName'];
      if (degradedReasons.includes(waitingReason)) {
        return { health: ComponentHealth.DEGRADED, healthReason: waitingReason };
      }
      return { health: ComponentHealth.PROGRESSING, healthReason: waitingReason };
    }

    if (cs?.state?.terminated) {
      const reason = cs.state.terminated.reason || 'Terminated';
      return { health: ComponentHealth.DEGRADED, healthReason: reason };
    }

    if (workload && workload.stable === false) {
      return { health: ComponentHealth.PROGRESSING, healthReason: 'rollout in progress' };
    }

    if (cs?.ready) {
      return { health: ComponentHealth.HEALTHY };
    }
    if (cs?.state?.running) {
      return { health: ComponentHealth.PROGRESSING, healthReason: 'not ready' };
    }
    return { health: ComponentHealth.UNKNOWN };
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
