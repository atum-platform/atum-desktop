import { render } from '@testing-library/react'
import { expect, it } from 'vitest'

import { CONSENT_SELECTOR, readConsentRegions } from '../../../shared/gui-consent'

import { ConsentBoundary } from './consent-boundary'

it('registers both answers through the shared boundary and excludes ordinary controls', () => {
  const { container } = render(<><button>Ordinary</button><ConsentBoundary><button>Confirm</button><button>Not now</button></ConsentBoundary></>)
  const buttons = container.querySelectorAll('button')
  buttons.forEach(button => {
    button.getClientRects = () => [{ x: 10, y: 20, width: 40, height: 30 }] as unknown as DOMRectList
  })
  expect(readConsentRegions(document, CONSENT_SELECTOR)).toHaveLength(2)
  expect(buttons[0]!.closest(CONSENT_SELECTOR)).toBeNull()
  expect(buttons[1]!.closest(CONSENT_SELECTOR)).not.toBeNull()
  expect(buttons[2]!.closest(CONSENT_SELECTOR)).not.toBeNull()
})

it('protects the independent proposal branch through its existing app-owned marker', () => {
  const { container } = render(<section data-matrix-agent-proposal="pending"><button>Confirm</button><button>Not now</button></section>)
  const section = container.querySelector('section')!
  section.getClientRects = () => [{ x: 10, y: 20, width: 100, height: 100 }] as unknown as DOMRectList
  expect(readConsentRegions(document, CONSENT_SELECTOR)).toContainEqual({ x: 10, y: 20, width: 100, height: 100 })
})
