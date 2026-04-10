import { UpdatePolicy, GitAuthType } from '../types';
import { logger } from './logger';

export function parsePolicyFromLabel(policyLabel?: string): UpdatePolicy | undefined {
  if (!policyLabel) return undefined;
  switch (policyLabel.toLowerCase()) {
    case 'all': return UpdatePolicy.ALL;
    case 'major': return UpdatePolicy.MAJOR;
    case 'minor': return UpdatePolicy.MINOR;
    case 'patch': return UpdatePolicy.PATCH;
    case 'force': return UpdatePolicy.FORCE;
    case 'glob': return UpdatePolicy.GLOB;
    default:
      logger.warn(`⚠️  Invalid policy label '${policyLabel}' - will use global default`);
      return undefined;
  }
}

export function parseAutoUpdateLabel(label?: string): boolean | undefined {
  if (!label) return undefined;
  return label === 'true';
}

export function parseJSONLabel(label?: string): string[] | undefined {
  if (!label) return undefined;
  try {
    const parsed = JSON.parse(label);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    logger.warn(`⚠️  Invalid JSON label format - expected JSON array`);
    return undefined;
  }
}

export function parseIntervalLabel(label?: string): number | undefined {
  if (!label) return undefined;
  const match = label.match(/^(\d+)(s|m)?$/);
  if (!match) {
    logger.warn(`⚠️  Invalid interval format: ${label}`);
    return undefined;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2] || 's';
  return unit === 's' ? value * 1000 : value * 60 * 1000;
}

export function parseGitAuthTypeLabel(label?: string): GitAuthType | undefined {
  if (!label) return undefined;
  switch (label.toLowerCase()) {
    case 'token': return GitAuthType.TOKEN;
    case 'ssh': return GitAuthType.SSH;
    case 'none': return GitAuthType.NONE;
    default:
      logger.warn(`⚠️  Invalid gitops-auth-type label '${label}'`);
      return undefined;
  }
}

export function extractRepoName(url: string): string {
  try {
    const match = url.match(/\/([^/]+?)(\.git)?$/);
    return match?.[1] || 'gitops-repo';
  } catch {
    return 'gitops-repo';
  }
}
