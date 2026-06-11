/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Light theme (Claude Design "Plotter Console Light"). Inverted neutral scale:
        // low index = darkest (text), high index = lightest (surfaces).
        ink: {
          950: '#eceff4',  // page background
          900: '#ffffff',  // card surface
          850: '#f4f7fa',  // input / inset surface
          800: '#e6ebf1',  // hover / divider / active
          750: '#dce3ec',  // hairline borders
          700: '#c4cedb',  // stronger borders
          600: '#9aa7b8',  // faint icon / corner labels
          500: '#6b7889',  // muted text
          400: '#4a5666',  // labels / section titles
          300: '#2f3a48',  // body text
          200: '#1c2530',  // input values
          100: '#0f1720',  // headings / strong values
        },
        go:    { DEFAULT: '#059669', dim: '#d1fae5', soft: '#10b981' },
        warn:  { DEFAULT: '#d97706', dim: '#fef3c7' },
        stop:  { DEFAULT: '#dc2626', dim: '#fee2e2' },
        cyanx: { DEFAULT: '#0284c7', dim: '#e0f2fe' },
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.06)',
      },
    },
  },
  plugins: [],
};
