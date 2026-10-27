import { describe, expect, it } from 'vitest';
import { HARNESS_EFFORTS, isSupportedEffort } from './harness-policy.js';
import { EFFORTS, HARNESSES, PROFILES } from './protocol.js';
import { SETTINGS_FIELDS } from './settings.js';

describe('shared harness policy', () => {
  it('preserves the protocol and settings vocabularies', () => {
    expect(HARNESSES).toEqual(['claude', 'pi', 'codex']);
    expect(PROFILES).toEqual(['orchestrator', 'implementation', 'explorer', 'mechanical', 'reviewer']);
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it.each(['claude', 'pi', 'codex'] as const)('keeps %s effort choices and acceptance aligned', (harness) => {
    const expected = harness === 'codex' ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(HARNESS_EFFORTS[harness]).toEqual(expected);
    expect(SETTINGS_FIELDS.find((field) => field.key === `profiles.${harness}.reviewer.effort`)?.options).toEqual(expected);
    for (const effort of expected) expect(isSupportedEffort(harness, effort)).toBe(true);
    for (const effort of ['', 'extreme', 'HIGH']) expect(isSupportedEffort(harness, effort)).toBe(false);
    expect(isSupportedEffort(harness, 'max')).toBe(harness !== 'codex');
  });
});
