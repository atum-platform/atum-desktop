import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { normalizeAwarenessRevision, sourceKey, validSource } from './normalize'
import type { AwarenessEnvelope, AwarenessEnvelopeContext, AwarenessRevision } from './types'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/contract-inputs.json', import.meta.url), 'utf8')) as {
  vectors: unknown
}

const vectors = fixtures.vectors as unknown as Record<string, AwarenessEnvelope>

function inputFor(name: string): {
  revision: AwarenessRevision
  context: AwarenessEnvelopeContext
  expected: AwarenessEnvelope
} {
  const expected = vectors[name]
  const { contract: _contract, operationId, observedTime, policy, digest: _digest, ...revision } = expected

  return {
    revision,
    context: {
      destination: 'managed',
      operationId,
      observedTime,
      epoch: policy.epoch,
      visibility: policy.visibility,
      accountFence: policy.accountFence
    },
    expected
  }
}

function envelope(result: ReturnType<typeof normalizeAwarenessRevision>): AwarenessEnvelope {
  expect(result.kind).toBe('envelope')

  if (result.kind !== 'envelope') {
    throw new Error('expected envelope')
  }

  return result.envelope
}

describe('normalizeAwarenessRevision', () => {
  it.each([
    'envelope-human-group-message.managed.json',
    'envelope-edit.managed.json',
    'envelope-redaction.managed.json'
  ])('emits the exact selected contract vector for %s', name => {
    const { revision, context, expected } = inputFor(name)
    expect(envelope(normalizeAwarenessRevision(revision, context))).toEqual(expected)
  })

  it('reconstructs only allowlisted fields', () => {
    const { revision, context, expected } = inputFor('envelope-human-group-message.managed.json')

    const injected = {
      ...revision,
      owner: 'not-exported',
      audience: ['not-exported'],
      token: 'not-exported',
      source: { ...revision.source, secret: 'not-exported' },
      object: { ...revision.object, audience: 'not-exported' },
      author: { ...revision.author, owner: 'not-exported' },
      content: { ...revision.content, apiKey: 'not-exported' }
    }

    expect(envelope(normalizeAwarenessRevision(injected, context))).toEqual(expected)
  })

  it('normalizes CRLF and NFC without trimming, then hashes the UTF-8 text', () => {
    const { revision, context } = inputFor('envelope-human-group-message.managed.json')
    const text = '  Cafe\u0301\r\nnext  '
    const result = envelope(normalizeAwarenessRevision({ ...revision, content: { text, attachments: [] } }, context))
    expect(result.content).toEqual({ text: '  Café\nnext  ', attachments: [] })
    expect(result.digest).toBe(createHash('sha256').update('  Café\nnext  ', 'utf8').digest('hex'))
  })

  it('uses Unicode code points for the text bound and never truncates', () => {
    const { revision, context } = inputFor('envelope-human-group-message.managed.json')
    expect(
      normalizeAwarenessRevision({ ...revision, content: { text: '😀'.repeat(65_536), attachments: [] } }, context).kind
    ).toBe('envelope')
    expect(
      normalizeAwarenessRevision({ ...revision, content: { text: '😀'.repeat(65_537), attachments: [] } }, context)
    ).toEqual({ kind: 'invalid' })
  })

  it.each([
    '-----BEGIN PRIVATE KEY-----',
    `Bearer ${'b'.repeat(32)}`,
    `sk_${'s'.repeat(32)}`,
    `ghp_${'g'.repeat(36)}`,
    `github_pat_${'p'.repeat(36)}`
  ])('rejects recognized credential-shaped text without reporting it', text => {
    const { revision, context } = inputFor('envelope-human-group-message.managed.json')
    expect(normalizeAwarenessRevision({ ...revision, content: { text, attachments: [] } }, context)).toEqual({
      kind: 'unsupported'
    })
  })

  it('does not reject ordinary credential-related prose', () => {
    const { revision, context } = inputFor('envelope-human-group-message.managed.json')
    const text = 'Please rotate the password after the bearer presents their credentials.'
    expect(
      envelope(normalizeAwarenessRevision({ ...revision, content: { text, attachments: [] } }, context)).content.text
    ).toBe(text)
  })

  it('validates attachment shape, preserves valid attachments, and caps their count', () => {
    const { revision, context } = inputFor('envelope-human-group-message.managed.json')

    const attachment = {
      kind: 'file' as const,
      ref: 'mxc://atumplatform.com/file',
      mime: 'text/plain',
      bytes: 12,
      parse: 'parsed' as const
    }

    expect(
      envelope(
        normalizeAwarenessRevision({ ...revision, content: { text: 'attached', attachments: [attachment] } }, context)
      ).content.attachments
    ).toEqual([attachment])
    expect(
      normalizeAwarenessRevision(
        {
          ...revision,
          content: { text: 'attached', attachments: [{ ...attachment, parse: 'bad' as unknown as 'parsed' }] }
        },
        context
      )
    ).toEqual({ kind: 'unsupported' })
    expect(
      normalizeAwarenessRevision(
        { ...revision, content: { text: 'attached', attachments: Array.from({ length: 17 }, () => attachment) } },
        context
      )
    ).toEqual({ kind: 'invalid' })
  })

  it('does not export redacted content under any malformed redaction payload', () => {
    const { revision, context, expected } = inputFor('envelope-redaction.managed.json')
    expect(envelope(normalizeAwarenessRevision(revision, context))).toEqual(expected)
    expect(
      normalizeAwarenessRevision({ ...revision, content: { text: 'original text', attachments: [] } }, context)
    ).toEqual({ kind: 'invalid' })
    expect(
      normalizeAwarenessRevision(
        {
          ...revision,
          content: {
            text: '',
            attachments: [{ kind: 'file', ref: 'a', mime: 'text/plain', bytes: 0, parse: 'parsed' }]
          }
        },
        context
      )
    ).toEqual({ kind: 'invalid' })
  })

  it('requires stable replacements for edits and redactions', () => {
    const edit = inputFor('envelope-edit.managed.json')
    const redaction = inputFor('envelope-redaction.managed.json')
    expect(
      normalizeAwarenessRevision({ ...edit.revision, object: { ...edit.revision.object, replaces: '' } }, edit.context)
    ).toEqual({ kind: 'invalid' })
    expect(
      normalizeAwarenessRevision(
        { ...redaction.revision, object: { ...redaction.revision.object, replaces: undefined } },
        redaction.context
      )
    ).toEqual({ kind: 'invalid' })
  })

  it('fails closed for a malformed provenance marker before content validation', () => {
    const { revision, context } = inputFor('envelope-human-group-message.managed.json')
    expect(
      normalizeAwarenessRevision(
        {
          ...revision,
          provenance: { v: 1, google: true, extra: true },
          content: { text: 'x'.repeat(65_537), attachments: [] }
        },
        context
      )
    ).toEqual({ kind: 'blocked', reason: 'google_fence' })
    expect(normalizeAwarenessRevision({ ...revision, provenance: null }, context)).toEqual({
      kind: 'blocked',
      reason: 'google_fence'
    })
    expect(
      normalizeAwarenessRevision(
        { ...revision, provenance: { v: 1, google: 'true' } },
        { ...context, destination: 'local' }
      )
    ).toEqual({ kind: 'invalid' })
  })

  it('blocks exact Google-derived managed payloads while allowing their local policy marker', () => {
    const { revision, context } = inputFor('envelope-human-group-message.managed.json')

    const blockedBeforeContent = {
      ...revision,
      provenance: { v: 1, google: true },
      content: { text: 'x'.repeat(65_537), attachments: [] }
    }

    expect(normalizeAwarenessRevision(blockedBeforeContent, context)).toEqual({
      kind: 'blocked',
      reason: 'google_fence'
    })
    const marked = { ...revision, provenance: { v: 1, google: true } }
    const local = envelope(normalizeAwarenessRevision(marked, { ...context, destination: 'local' }))
    expect(local.policy.googleDerived).toBe(true)
    expect(local.content).toEqual(revision.content)
  })

  it('blocks a managed drive source behind the account fence but retains unmarked messages', () => {
    const { revision, context } = inputFor('envelope-human-group-message.managed.json')
    expect(
      normalizeAwarenessRevision(
        { ...revision, source: { ...revision.source, kind: 'drive_file' } },
        { ...context, accountFence: true }
      )
    ).toEqual({ kind: 'blocked', reason: 'google_fence' })
    const allowed = envelope(normalizeAwarenessRevision(revision, { ...context, accountFence: true }))
    expect(allowed.policy.accountFence).toBe(true)
    expect(allowed.content).toEqual(revision.content)
  })

  it('rejects unsafe metadata and reports unsupported enum values separately', () => {
    const { revision, context } = inputFor('envelope-human-group-message.managed.json')
    expect(normalizeAwarenessRevision({ ...revision, eventTime: Number.MAX_SAFE_INTEGER + 1 }, context)).toEqual({
      kind: 'invalid'
    })
    expect(normalizeAwarenessRevision(revision, { ...context, operationId: 'not-a-uuid' })).toEqual({ kind: 'invalid' })
    expect(
      normalizeAwarenessRevision(
        { ...revision, object: { ...revision.object, kind: 42 as unknown as 'message' } },
        context
      )
    ).toEqual({ kind: 'invalid' })
    expect(
      normalizeAwarenessRevision(
        { ...revision, source: { ...revision.source, kind: 'remote' as unknown as 'human_group' } },
        context
      )
    ).toEqual({ kind: 'unsupported' })
  })

  it('provides validated source keys without ambiguous concatenation', () => {
    const source = inputFor('envelope-human-group-message.managed.json').revision.source
    expect(validSource(source)).toBe(true)
    expect(validSource({ kind: 'human_group', id: 'space here' })).toBe(false)
    expect(validSource({ ...source, adapterMetadata: 'allowed for normalization, rejected for durable keys' })).toBe(
      false
    )
    expect(sourceKey(source)).toBe(JSON.stringify([source.kind, source.id, null]))
  })
})
