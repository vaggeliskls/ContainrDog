import { describe, it, expect } from 'vitest';
import {
  parsePolicyFromLabel,
  parseAutoUpdateLabel,
  parseJSONLabel,
  parseIntervalLabel,
  parseGitAuthTypeLabel,
  extractRepoName,
} from '../../../src/utils/label-parser';
import { UpdatePolicy, GitAuthType } from '../../../src/types';

describe('parsePolicyFromLabel', () => {
  it.each([
    ['all', UpdatePolicy.ALL],
    ['major', UpdatePolicy.MAJOR],
    ['minor', UpdatePolicy.MINOR],
    ['patch', UpdatePolicy.PATCH],
    ['force', UpdatePolicy.FORCE],
    ['glob', UpdatePolicy.GLOB],
  ])('lowercased %s → %s', (input, expected) => {
    expect(parsePolicyFromLabel(input)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(parsePolicyFromLabel('MAJOR')).toBe(UpdatePolicy.MAJOR);
    expect(parsePolicyFromLabel('Minor')).toBe(UpdatePolicy.MINOR);
  });

  it('returns undefined for unknown policy', () => {
    expect(parsePolicyFromLabel('rolling')).toBeUndefined();
  });

  it('returns undefined for empty/undefined input', () => {
    expect(parsePolicyFromLabel(undefined)).toBeUndefined();
    expect(parsePolicyFromLabel('')).toBeUndefined();
  });
});

describe('parseAutoUpdateLabel', () => {
  it('returns true for "true"', () => expect(parseAutoUpdateLabel('true')).toBe(true));
  it('returns false for "false"', () => expect(parseAutoUpdateLabel('false')).toBe(false));
  it('returns false for any other string', () => expect(parseAutoUpdateLabel('yes')).toBe(false));
  it('returns undefined for undefined', () => expect(parseAutoUpdateLabel(undefined)).toBeUndefined());
});

describe('parseJSONLabel', () => {
  it('parses JSON array of strings', () => {
    expect(parseJSONLabel('["cmd1","cmd2","cmd3"]')).toEqual(['cmd1', 'cmd2', 'cmd3']);
  });

  it('wraps a scalar string in an array', () => {
    expect(parseJSONLabel('"single"')).toEqual(['single']);
  });

  it('returns undefined for invalid JSON', () => {
    expect(parseJSONLabel('not-json')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(parseJSONLabel(undefined)).toBeUndefined();
  });
});

describe('parseIntervalLabel', () => {
  it('parses seconds suffix', () => expect(parseIntervalLabel('30s')).toBe(30_000));
  it('parses minutes suffix', () => expect(parseIntervalLabel('5m')).toBe(300_000));
  it('treats bare number as seconds', () => expect(parseIntervalLabel('60')).toBe(60_000));

  it('returns undefined for unsupported unit (h)', () => {
    expect(parseIntervalLabel('5h')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(parseIntervalLabel(undefined)).toBeUndefined();
  });
});

describe('parseGitAuthTypeLabel', () => {
  it.each([
    ['token', GitAuthType.TOKEN],
    ['ssh', GitAuthType.SSH],
    ['none', GitAuthType.NONE],
  ])('%s → %s', (input, expected) => {
    expect(parseGitAuthTypeLabel(input)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(parseGitAuthTypeLabel('TOKEN')).toBe(GitAuthType.TOKEN);
  });

  it('returns undefined for unknown value', () => {
    expect(parseGitAuthTypeLabel('oauth')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(parseGitAuthTypeLabel(undefined)).toBeUndefined();
  });
});

describe('extractRepoName', () => {
  it.each([
    ['https://github.com/user/myrepo.git', 'myrepo'],
    ['https://github.com/user/myrepo', 'myrepo'],
    ['git@github.com:user/myrepo.git', 'myrepo'],
    ['ssh://git@github.com/user/myrepo.git', 'myrepo'],
    ['https://gitlab.com/org/team/repo.git', 'repo'],
  ])('%s → %s', (url, expected) => {
    expect(extractRepoName(url)).toBe(expected);
  });
});
