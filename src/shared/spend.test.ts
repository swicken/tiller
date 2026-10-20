import { describe, expect, it } from 'vitest';
import { fmtUsd } from './spend.js';

describe('fmtUsd', () => {
  it.each([
    [0, '$0.00'],
    [0.0009, '<$0.01'],
    [0.004, '<$0.01'],
    [0.005, '<$0.01'],
    [0.01, '$0.01'],
    [1.234, '$1.23'],
  ])('formats %s as %s', (usd, text) => {
    expect(fmtUsd(usd)).toBe(text);
    expect(fmtUsd(usd, false)).toBe(text);
    expect(fmtUsd(usd, true)).toBe(`${text}+`);
  });
});
