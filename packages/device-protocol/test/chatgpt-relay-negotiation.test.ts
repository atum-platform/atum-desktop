import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEVICE_HUB_MAX_PAYLOAD_BYTES, frameViolations, parseEnvelope, parseFrame } from '../messages';

const fixture = (path: string) => JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8'));
const negotiation = fixture('chatgpt-relay-negotiation.json');
const hellos = [
  'device-service/fixtures/hello.frame.json',
  'device-service-v1.2/fixtures/source-hello.json',
  'device-workspace/fixtures/hello.json'
];

describe('signed Hello relay transport advertisement', () => {
  it('matches the negotiation fixture and preserves the legacy Hello', () => {
    const legacy = fixture(hellos[0]);
    expect(parseFrame(JSON.stringify(legacy))).toEqual(legacy);
    expect(negotiation.upgraded.chatGptRelayMaxBytes).toBe(DEVICE_HUB_MAX_PAYLOAD_BYTES);
    const upgraded = { ...legacy, body: { ...legacy.body, ...negotiation.upgraded } };
    expect(parseFrame(JSON.stringify(upgraded))).toEqual(upgraded);
  });

  it.each(hellos)('validates the field alongside Hello extensions in %s', path => {
    const hello = fixture(path);
    for (const bytes of [1, DEVICE_HUB_MAX_PAYLOAD_BYTES, Number.MAX_SAFE_INTEGER]) {
      hello.body.chatGptRelayMaxBytes = bytes;
      expect(frameViolations(hello)).toEqual([]);
    }
    for (const invalid of [...negotiation.invalid, Number.MAX_SAFE_INTEGER + 1, undefined, false]) {
      hello.body.chatGptRelayMaxBytes = invalid;
      expect(frameViolations(hello)).toContainEqual(expect.objectContaining({ path: '$.body.chatGptRelayMaxBytes' }));
      expect(() => parseEnvelope(hello)).toThrow('device_envelope_invalid');
      if (invalid !== undefined) {
        expect(() => parseFrame(JSON.stringify(hello))).toThrow();
      }
    }
  });
});
