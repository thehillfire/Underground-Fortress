// Chat themes. A theme only changes how the chat LOOKS (CSS variables + a style attribute);
// every theme runs the exact same chat code, so nothing can work differently between them.
//
// Today: a style (Modern, Retro squares) and a color. The same mechanism is where bigger
// world themes (spaceship, ship at sea, …) will plug in: another entry, its own variables.

export const STYLES = [
  { id: 'modern', name: 'Modern', note: 'Rounded bubbles' },
  { id: 'retro', name: 'Retro squares', note: 'The original bunker look' },
];

export const COLORS = [
  { id: 'red', name: 'Red', hex: '#b0222a' },
  { id: 'green', name: 'Green', hex: '#1f9a55' },
  { id: 'blue', name: 'Blue', hex: '#2f7de0' },
  { id: 'purple', name: 'Purple', hex: '#8a4bd6' },
  { id: 'pink', name: 'Pink', hex: '#d44a95' },
  { id: 'amber', name: 'Amber', hex: '#d08a1a' },
  { id: 'teal', name: 'Teal', hex: '#14a090' },
];

export const DEFAULT_THEME = { chatStyle: 'modern', chatColor: '#b0222a' };

function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = parseInt((m ? m[1] : 'b0222a'), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = Math.round(((h * 60) + 360) % 360);
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h, s: Math.round(Math.min(85, Math.max(40, s * 100))) };
}

const hsl = (h, s, l, a) => `hsl(${h % 360} ${s}% ${l}%${a != null ? ` / ${a}` : ''})`;

/** Every color the chat uses, derived from one hue. */
export function themeVars(style, hex) {
  const { h, s } = hexToHsl(hex);
  const v = {
    '--t-bg': hsl(h, 14, 5), '--t-head': hsl(h, 16, 7, 0.97), '--t-line': hsl(h, 18, 16),
    '--t-title': hsl(h, 90, 92), '--t-acc': hsl(h, 85, 70), '--t-btn': hsl(h, s, 42),
    '--t-me1': hsl(h, s, 42), '--t-me2': hsl(h, s, 33), '--t-me-fg': '#fff', '--t-me-line': hsl(h, s, 42),
    '--t-them': hsl(h, 12, 15), '--t-them-fg': hsl(h, 20, 92), '--t-them-line': hsl(h, 12, 15),
    '--t-card': hsl(h, 18, 9), '--t-card-line': hsl(h, 30, 24),
    '--t-input': hsl(h, 12, 11), '--t-input-line': hsl(h, 14, 20), '--t-pop': hsl(h, 12, 17),
    '--t-muted': hsl(h, 8, 45), '--t-think': hsl(h, 10, 52), '--t-think-line': hsl(h, 14, 22), '--t-sys': hsl(h, 14, 8),
    '--t-seen': hsl(h, 90, 62),
  };
  if (style === 'retro') {
    // The original look: her bubbles in the chosen color, yours in its contrasting green.
    const h2 = (h + 128) % 360;
    Object.assign(v, {
      '--t-bg': hsl(h, 14, 4), '--t-head': hsl(h, 55, 5), '--t-line': hsl(h, 60, 11),
      '--t-me1': hsl(h2, 30, 18), '--t-me2': hsl(h2, 30, 18), '--t-me-line': hsl(h2, 38, 30), '--t-me-fg': hsl(h2, 30, 92),
      '--t-them': hsl(h, 50, 11), '--t-them-fg': hsl(h, 30, 92), '--t-them-line': hsl(h, 78, 28),
      '--t-btn': hsl(h, s, 36), '--t-input': hsl(h, 20, 8), '--t-input-line': hsl(h, 40, 18),
    });
  }
  return v;
}

let applied = '';
/** Put a theme on the chat element. Cheap to call on every state push. */
export function applyTheme(el, settings = {}) {
  const style = STYLES.some(s => s.id === settings.chatStyle) ? settings.chatStyle : DEFAULT_THEME.chatStyle;
  const color = /^#[0-9a-f]{6}$/i.test(settings.chatColor || '') ? settings.chatColor : DEFAULT_THEME.chatColor;
  const key = `${style}|${color}`;
  if (key === applied) return;
  applied = key;
  el.dataset.style = style;
  for (const [k, val] of Object.entries(themeVars(style, color))) el.style.setProperty(k, val);
}
