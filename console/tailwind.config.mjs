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
        ink: {
          950: '#0a0d11',
          900: '#0e1318',
          850: '#131a21',
          800: '#19222b',
          750: '#202b36',
          700: '#2a3845',
          600: '#3a4c5c',
          500: '#5b7186',
          400: '#7e95aa',
          300: '#a7bccd',
        },
        go:   { DEFAULT: '#34d399', dim: '#0f3a2c', soft: '#6ee7b7' },
        warn: { DEFAULT: '#fbbf24', dim: '#3d2f0a' },
        stop: { DEFAULT: '#f87171', dim: '#3a1414' },
        cyanx: { DEFAULT: '#38bdf8', dim: '#0b2f44' },
      },
    },
  },
  plugins: [],
};
