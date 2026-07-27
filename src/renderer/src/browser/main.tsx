import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '../assets/main.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserChrome } from './BrowserChrome'

// Reserve space for the native window-control overlay (same as the main window).
document.documentElement.dataset.platform = window.electron?.process?.platform ?? 'win32'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserChrome />
  </React.StrictMode>
)
