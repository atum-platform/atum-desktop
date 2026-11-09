import { describe, expect, it } from 'vitest'
import { CloudIntents } from '../src/cloud-intents'

describe('CloudIntents', () => {
  it('reuses the request ID for a retry and makes a new intent distinct', () => {
    let count = 0
    const intents = new CloudIntents(() => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`)
    expect(intents.requestId('funding:true')).toBe(intents.requestId('funding:true'))
    expect(intents.requestId('funding:false')).not.toBe(intents.requestId('funding:true'))
  })
})
