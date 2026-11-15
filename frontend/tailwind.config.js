/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: { short: { raw: '(min-width: 1024px) and (max-height: 820px)' } },
      colors: {
        bg: 'var(--bg)',
        s1: 'var(--surface-1)',
        s2: 'var(--surface-2)',
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        text: 'var(--text)',
        muted: 'var(--text-muted)',
        brand: 'var(--brand)',
        'on-brand': 'var(--on-brand)',
        'brand-soft': 'var(--brand-soft)',
        starlight: 'var(--starlight)',
        ok: 'var(--ok)',
        watch: 'var(--watch)',
        act: 'var(--act)',
        nodata: 'var(--nodata)',
      },
      fontFamily: {
        sans: ['"Atkinson Hyperlegible Next"', 'system-ui', 'sans-serif'],
        display: ['"Chakra Petch"', 'sans-serif'],
        mono: ['ui-monospace', 'monospace'],
        arabic: ['"Readex Pro"', 'sans-serif'],
      },
      fontSize: { xs: ['12px', '16px'], sm: ['14px', '20px'], base: ['16px', '24px'], lg: ['20px', '28px'], xl: ['28px', '34px'], '2xl': ['40px', '44px'] },
      borderRadius: { card: '2px' },
    },
  },
  plugins: [],
};
