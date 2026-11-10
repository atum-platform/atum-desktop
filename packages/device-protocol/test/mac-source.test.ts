import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEVICE_SERVICE_1_2_PACK, DEVICE_SERVICE_PACK } from '../contract-packs';
import { argsHash } from '../hashes';
import { frameViolations, helloSourceStatus, parseFrame, toolCapability } from '../messages';
import { check, messageViolations, type Violation } from '../schema';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/device-service-v1.2/fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('device-service/1.2 advisory negotiation', () => {
  it.each(['source-hello', 'source-hello-legacy', 'source-hello-malformed', 'source-read', 'source-scan', 'source-refusal'])('accepts %s on the wire', name => {
    const value = fixture(name);
    expect(frameViolations(value)).toEqual([]);
  });
  it.each([null, false, [], 'ready', {}, { messages: 'ready' }, { messages: 'broken', browser: 'off', location: 'off', folders: 'off' }, { token: 'must not be interpreted' }])('ignores malformed optional sources %j without changing authenticated bytes', sources => {
    const value = fixture('source-hello');
    value.body.sources = sources;
    const raw = JSON.stringify(value);
    expect(parseFrame(raw)).toEqual(value);
    expect(helloSourceStatus(value.body)).toBeUndefined();
    expect(JSON.stringify(value)).toBe(raw);
  });
  it.each([undefined, null, false, 2, '1'])('ignores unsupported sourceProtocol %j', protocol => {
    const value = fixture('source-hello');
    value.body.sourceProtocol = protocol;
    expect(frameViolations(value)).toEqual([]);
    expect(helloSourceStatus(value.body)).toBeUndefined();
  });
  it('preserves strict core validation and rejection by the frozen base pack', () => {
    const value = fixture('source-hello');
    expect(messageViolations(DEVICE_SERVICE_PACK, 'frame.Hello', value).length).toBeGreaterThan(0);
    value.body.capabilities.sources = {};
    expect(frameViolations(value)).toContainEqual({ category: 'unknown_field', path: '$.body.capabilities.sources' });
  });
  it('uses files scope, strict source operations, and bounded arguments/results', () => {
    expect(toolCapability('mac_source')).toBe('files');
    const value = fixture('source-scan');
    value.body.args.operationRef = 'mac.run_shell';
    expect(frameViolations(value).length).toBeGreaterThan(0);
    value.body.args = { mode: 'read', request: { text: 'a'.repeat(65537) } };
    expect(frameViolations(value).length).toBeGreaterThan(0);
    const errors: Violation[] = [];
    check({ ref: 'mac_source_result' }, { data: 'a'.repeat(262144) }, '$', DEVICE_SERVICE_1_2_PACK.types, errors);
    expect(errors).toContainEqual({ category: 'bound', path: '$' });
  });
  it.each(['source-read', 'source-scan'])('binds %s arguments to their digest', name => {
    const value = fixture(name);
    expect(value.body.argsHash).toBe(argsHash(value.body.args));
  });
});
