import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import './assets/main.css'
import 'streamdown/styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AppContextMenu } from './components/AppContextMenu'

// Tag the platform so CSS can reserve room for the native window controls
// (traffic lights on macOS, control overlay on Windows/Linux).
document.documentElement.dataset.platform = window.electron?.process?.platform ?? 'win32'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {/* Right-click Cut/Copy/Paste, app-wide. Mounted beside the router rather
        than inside it so it covers every screen, including the splash. */}
    <AppContextMenu />
    <App />
  </React.StrictMode>
)
