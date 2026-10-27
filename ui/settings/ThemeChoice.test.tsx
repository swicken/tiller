import { beforeEach, expect, it, vi } from 'vitest';
import { elements } from '../test-tree';
import { ThemeChoice } from './ThemeChoice';
import { setThemePref } from '../theme';

// One state slot, kept across renders; the component is called directly, without a DOM.
const state = vi.hoisted(() => ({ slot: undefined as unknown }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: () => unknown) => {
    state.slot ??= initial();
    return [state.slot, (next: unknown) => { state.slot = next; }];
  },
}));
vi.mock('../theme', () => ({ themePref: () => 'system', setThemePref: vi.fn() }));

const radios = () => elements(ThemeChoice()).filter((e) => e.props.role === 'radio');
const checked = () => radios().filter((e) => e.props['aria-checked']).map((e) => e.props.children);

beforeEach(() => { state.slot = undefined; vi.mocked(setThemePref).mockClear(); });

it('offers System, Light and Dark with the stored choice checked', () => {
  expect(radios().map((e) => e.props.children)).toEqual(['System', 'Light', 'Dark']);
  expect(checked()).toEqual(['System']);
});

it('applies a choice at once and checks it', () => {
  radios().find((e) => e.props.children === 'Light')!.props.onClick();
  expect(setThemePref).toHaveBeenCalledExactlyOnceWith('light');
  expect(checked()).toEqual(['Light']);
  // A plain button, so it can never submit the settings form.
  expect(radios().every((e) => e.props.type === 'button')).toBe(true);
});
