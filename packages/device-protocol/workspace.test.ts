import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEVICE_WORKSPACE_PACK } from './contract-packs';
import { controllerSigner, publicKeyMaterial, signControllerEnvelope, signDeviceEnvelope, softwareP256Signer, verifyControllerEnvelope, verifyDeviceEnvelope } from './envelope';
import { frameViolations, parseEnvelope } from './messages';
import { workspaceBinding, workspaceFinalizeRefusal, workspaceResultHash } from './workspace';
import type { WorkspaceFinalize, WorkspaceResult } from './workspace-messages';

const fixture = (name: string) => JSON.parse(readFileSync(new URL('./fixtures/device-workspace/fixtures/'+name+'.json', import.meta.url), 'utf8'));
describe('workspace companion', () => {
  for (const f of (DEVICE_WORKSPACE_PACK as any).fixtures) {
    it(f.file, () => {
      const value = JSON.parse(readFileSync(new URL('./fixtures/device-workspace/'+f.file, import.meta.url), 'utf8'));
      const violations = frameViolations(value);
      if (f.expect === 'accept') expect(violations).toEqual([]);
      else expect(violations.some(v => v.category === f.violation)).toBe(true);
    });
  }
  it('crosses real controller/device signature bytes and binds the result hash', async () => {
    const controller = controllerSigner(generateKeyPairSync('ed25519').privateKey);
    const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = publicKeyMaterial(device.publicKey);
    const request: WorkspaceFinalize = fixture('workspacefinalize').body;
    const signed = signControllerEnvelope(controller, 'WorkspaceFinalize', request);
    expect(parseEnvelope(signed, 'controller_to_device').type).toBe('WorkspaceFinalize');
    expect(verifyControllerEnvelope(signed, controller.publicKey)).toBe(true);
    const body: WorkspaceResult = fixture('workspaceresult').body;
    body.resultHash = workspaceResultHash(body);
    const result = await signDeviceEnvelope(key.kid, 'WorkspaceResult', body, softwareP256Signer(device.privateKey));
    expect(parseEnvelope(result, 'device_to_controller').type).toBe('WorkspaceResult');
    expect(verifyDeviceEnvelope(result, key.publicKey)).toBe(true);
    result.body.complete = false;
    expect(verifyDeviceEnvelope(result, key.publicKey)).toBe(false);
    expect(workspaceResultHash(result.body)).not.toBe(result.body.resultHash);
  });
  it('uses stored grant/connection/lease facts, refusing a replay on another epoch', () => {
    const request: WorkspaceFinalize = fixture('workspacefinalize').body;
    const session = workspaceBinding(request);
    const grant = { grantId: request.grantId, invocationId: request.invocationId, connectionId: request.connectionId,
      targetDeviceServiceId: request.deviceServiceId, enrollmentEpoch: request.enrollmentEpoch, accountEpoch: request.accountEpoch,
      writerEpoch: request.writerEpoch, expiresAt: request.expiresAt } as any;
    expect(workspaceFinalizeRefusal(request, grant, session, request.issuedAt)).toBeNull();
    expect(workspaceFinalizeRefusal(request, grant, {...session, connectionEpoch: session.connectionEpoch+1}, request.issuedAt)).toBe('binding_mismatch');
    expect(workspaceFinalizeRefusal(request, {...grant, writerEpoch: {...grant.writerEpoch, leaseGeneration: 0}}, session, request.issuedAt)).toBe('binding_mismatch');
    expect(workspaceFinalizeRefusal(request, grant, session, request.expiresAt)).toBe('expired');
  });
});
