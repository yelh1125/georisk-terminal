import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx}', './components/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#f4f7f8',
        ink: '#102126',
        teal: '#087e8b',
        mint: '#a8dadc',
        signal: '#e76f51',
      },
      boxShadow: { panel: '0 8px 24px rgba(18, 50, 56, 0.08)' },
    },
  },
  plugins: [],
};

export default config;
