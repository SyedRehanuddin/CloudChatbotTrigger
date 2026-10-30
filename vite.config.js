import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development, keep http://localhost:8000/ working.
// GitHub Pages hosts this repository under /CloudChatbotTrigger/.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/CloudChatbotTrigger/' : '/',
}))
