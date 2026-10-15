export default {
  plugins: {
    // Tailwind v4 has no tailwind.config.js by default: the tokens come from
    // `@theme` in globals.css and the PostCSS plugin is all it needs.
    '@tailwindcss/postcss': {},
  },
}