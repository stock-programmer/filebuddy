import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, loadConfig } from '../src/config.js';

describe('model timeout settings', () => {
  it('separates first-content waiting and stream idle time without a request or run total deadline', () => {
    expect(loadConfig({ env: {} }).run.requestIdleTimeoutMs).toBe(90000);
    expect(loadConfig({ env: {} }).run.requestFirstContentTimeoutMs).toBe(300000);
    expect(
      loadConfig({ env: { AGENT_REQUEST_TIMEOUT_MS: '240000', AGENT_REQUEST_IDLE_TIMEOUT_MS: '120000' } }).run
        .requestIdleTimeoutMs,
    ).toBe(120000);
    expect(DEFAULT_LIMITS).not.toHaveProperty('requestTimeoutMs');
    expect(DEFAULT_LIMITS).not.toHaveProperty('maxMs');
  });

  it.each(['0', '-1', 'NaN', 'Infinity', '1000.5', '3600001', 'abc'])(
    'rejects unsafe idle timer value %s while ignoring the obsolete total timeout setting',
    (value) => {
      expect(loadConfig({ env: { AGENT_REQUEST_TIMEOUT_MS: value } }).run.requestIdleTimeoutMs).toBe(
        DEFAULT_LIMITS.requestIdleTimeoutMs,
      );
      expect(() => loadConfig({ env: { AGENT_REQUEST_IDLE_TIMEOUT_MS: value } })).toThrow(
        'AGENT_REQUEST_IDLE_TIMEOUT_MS',
      );
    },
  );

  it('accepts an unset or blank override without mutating the defaults', () => {
    expect(
      loadConfig({ env: { AGENT_REQUEST_TIMEOUT_MS: ' ', AGENT_REQUEST_IDLE_TIMEOUT_MS: '' } }).run
        .requestIdleTimeoutMs,
    ).toBe(DEFAULT_LIMITS.requestIdleTimeoutMs);
  });
});
