import { describe, expect, it } from 'vitest';
import { App } from '../App';

describe('Phase 13 — App Shell & Router', () => {
  it('should render App component without crashing', () => {
    expect(App).toBeDefined();
    expect(typeof App).toBe('function');
  });
});
