import { useState } from 'react';
import { setThemePref, themePref, type ThemePref } from '../theme';

const CHOICES: [ThemePref, string][] = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

/** The viewer's theme: applied at once and kept in this browser's storage, so it is not part of the settings form. */
export function ThemeChoice() {
  const [pref, setPref] = useState(themePref);
  const choose = (next: ThemePref) => { setThemePref(next); setPref(next); };
  return <div className="settings-theme">
    <span id="settings-theme-label">Theme</span>
    <div className="seg" role="radiogroup" aria-labelledby="settings-theme-label">
      {CHOICES.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={pref === value} className={pref === value ? 'on' : ''} onClick={() => choose(value)}>{label}</button>)}
    </div>
    <small>Only in this browser or app.</small>
  </div>;
}
