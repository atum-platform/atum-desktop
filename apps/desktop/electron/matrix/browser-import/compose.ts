import path from 'node:path'

import type { MacDeviceIdentity } from '../device/cloud-agent'

import { defaultChromeEnv } from './chrome-cookies'
import { httpBrowserImportTransport, type HttpBrowserImportTransportOptions } from './client'
import { fileLastImportStore } from './last-import'
import { BrowserImportService } from './service'

/** What the browser import borrows from main: live account facts, never a renderer value. */
export interface BrowserImportHost {
  /** The user's home directory (where Chrome keeps its profiles). */
  home: string
  /** Electron `userData`, for the one small record of the last import. */
  userData: string
  /** This Mac's device identity, or undefined before main has made it. */
  identity(): Pick<MacDeviceIdentity, 'browserImportDevice' | 'enroll'> | undefined
  /** `account.s1Request`: the owner's native bearer and the domain base URL. */
  call: HttpBrowserImportTransportOptions['call']
  /** The signed-in owner's Matrix user id, or null. */
  owner(): string | null
  /** The owner's primary agent (the platform's default role), or null until the roster has said. */
  primaryAgent(): { principal: string; name?: string } | null
  locale(): string | undefined
  /** Hold the GUI broker still while the Touch ID is up. */
  setPaused(paused: boolean): void
  log(line: string): void
}

/** The import as main runs it: Chrome on this Mac, this Mac's enrolled device, the platform's owner routes. */
export function createBrowserImport(host: BrowserImportHost): BrowserImportService {
  return new BrowserImportService({
    chrome: defaultChromeEnv(host.home),
    transport: httpBrowserImportTransport({ call: host.call }),
    owner: host.owner,
    primaryAgent: host.primaryAgent,
    device: () => host.identity()?.browserImportDevice() ?? null,
    ensureEnrolled: async signal => {
      await host.identity()?.enroll(signal)
    },
    locale: host.locale,
    setPaused: host.setPaused,
    store: fileLastImportStore(path.join(host.userData, 'browser-import.json')),
    log: host.log
  })
}
