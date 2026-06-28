import type { ElectronAPI } from '@electron-toolkit/preload'
import type { RoxyApi } from '../shared/api'

declare global {
  interface Window {
    electron: ElectronAPI
    roxy: RoxyApi
  }
}
