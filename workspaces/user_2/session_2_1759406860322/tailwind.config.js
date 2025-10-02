/** @type {import('tailwindcss').Config} */
module.exports = {
  // Enable dark mode via class strategy (toggle with a 'dark' class on root)
  darkMode: 'class',

  content: [
    "./src/**/*.{js,jsx,ts,tsx}", // Scan all source React files for Tailwind classes
  ],

  theme: {
    extend: {
      colors: {
        primary: {
          light: '#6D28D9',
          DEFAULT: '#5B21B6',
          dark: '#4C1D95',
        },
        secondary: {
          light: '#FBBF24',
          DEFAULT: '#F59E0B',
          dark: '#B45309',
        },
        accent: '#10B981', // emerald green accent
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
        serif: ['Merriweather', 'serif'],
        mono: ['Fira Code', 'monospace'],
      },
      borderRadius: {
        xl: '1rem',
        '2xl': '1.5rem',
      },
      boxShadow: {
        'md-dark': '0 4px 6px rgba(0, 0, 0, 0.8)',
      },
    },
  },

  plugins: [
    require('@tailwindcss/forms'),      // Better form element styling
    require('@tailwindcss/typography'), // Nice prose styling for content
    require('@tailwindcss/aspect-ratio'), // For maintaining aspect ratios on elements
  ],
}


