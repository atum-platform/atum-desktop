/** Isolated, cosmetic-only atum.panel/1 relay. No host capabilities or tokens. */
import { ipcRenderer } from 'electron'

const nonce = process.argv.find(arg => arg.startsWith('--atum-panel-nonce='))?.split('=')[1]

if (nonce && window.top === window) {
  const ready = () => window.postMessage({ profile: 'atum.panel/1', type: 'ready', nonce }, window.location.origin)
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== window.location.origin) {return}
    const body = event.data

    if (!body || Object.keys(body).length !== 3 || body.profile !== 'atum.panel/1'
      || body.nonce !== nonce || (body.type !== 'ready' && body.type !== 'ack')) {return}

    ipcRenderer.send('atum:panel:guest', body)
  })
  ipcRenderer.on('atum:panel:host', (_event, body) => {
    if (body?.profile === 'atum.panel/1' && body.type === 'host-context' && body.nonce === nonce) {
      window.postMessage(body, window.location.origin)
    }
  })
  window.addEventListener('DOMContentLoaded', ready, { once: true })
}
