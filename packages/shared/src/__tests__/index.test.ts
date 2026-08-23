import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../index.js';

describe('@payrecover/shared', () => {
  it('should export package name', () => {
    expect(PACKAGE_NAME).toBe('@payrecover/shared');
  });

  it('should export package version', () => {
    expect(PACKAGE_VERSION).toBe('0.1.0');
  });
});
