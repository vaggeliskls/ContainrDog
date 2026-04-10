import { describe, it, expect } from 'vitest';
import { ImageParser } from '../../../src/utils/image-parser';

describe('ImageParser.parse', () => {
  it('parses official Docker Hub image with tag', () => {
    expect(ImageParser.parse('nginx:1.21.0')).toEqual({
      registry: 'docker.io',
      repository: 'library/nginx',
      tag: '1.21.0',
    });
  });

  it('defaults tag to latest when no tag given', () => {
    const result = ImageParser.parse('nginx');
    expect(result.tag).toBe('latest');
    expect(result.repository).toBe('library/nginx');
  });

  it('parses user-scoped Docker Hub image', () => {
    expect(ImageParser.parse('myuser/myapp:tag')).toEqual({
      registry: 'docker.io',
      repository: 'myuser/myapp',
      tag: 'tag',
    });
  });

  it('parses ghcr.io image', () => {
    expect(ImageParser.parse('ghcr.io/owner/repo:v1.2.3')).toEqual({
      registry: 'ghcr.io',
      repository: 'owner/repo',
      tag: 'v1.2.3',
    });
  });

  it('parses custom registry with port', () => {
    expect(ImageParser.parse('localhost:5000/myapp:latest')).toEqual({
      registry: 'localhost:5000',
      repository: 'myapp',
      tag: 'latest',
    });
  });

  it('parses explicit docker.io registry', () => {
    expect(ImageParser.parse('docker.io/library/nginx:latest')).toEqual({
      registry: 'docker.io',
      repository: 'library/nginx',
      tag: 'latest',
    });
  });

  it('parses ECR registry', () => {
    const result = ImageParser.parse('123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:v2.0.0');
    expect(result.registry).toBe('123456789.dkr.ecr.us-east-1.amazonaws.com');
    expect(result.repository).toBe('myapp');
    expect(result.tag).toBe('v2.0.0');
  });
});

describe('ImageParser.toString', () => {
  it('omits docker.io prefix', () => {
    expect(
      ImageParser.toString({ registry: 'docker.io', repository: 'library/nginx', tag: '1.21.0' })
    ).toBe('library/nginx:1.21.0');
  });

  it('includes non-docker.io registry', () => {
    expect(
      ImageParser.toString({ registry: 'ghcr.io', repository: 'owner/repo', tag: 'v1.0.0' })
    ).toBe('ghcr.io/owner/repo:v1.0.0');
  });

  it('roundtrips ghcr.io image', () => {
    const original = 'ghcr.io/owner/repo:v1.2.3';
    expect(ImageParser.toString(ImageParser.parse(original))).toBe(original);
  });
});

describe('ImageParser.isSemanticVersion', () => {
  it.each([
    ['1.2.3', true],
    ['v1.2.3', true],
    ['1.2', true],
    ['v1.2', true],
    ['1.2.3-alpha', true],
    ['1.2.3-rc.1', true],
    ['latest', false],
    ['main', false],
    ['stable', false],
    ['20231201', false],
    ['sha256:abc123', false],
  ])('%s → %s', (tag, expected) => {
    expect(ImageParser.isSemanticVersion(tag)).toBe(expected);
  });
});
