import { expect, it } from 'vitest';
import projection from '../fixtures/native-ssh-username-v1.6.json';
import { check, type SchemaNode } from '../schema';

for (const sample of projection.cases) {
  it(`native SSH username ${JSON.stringify(sample.user)}`, () => {
    const violations: Parameters<typeof check>[4] = [];
    check(projection.schema as SchemaNode, sample.user, '$.user', {}, violations);
    expect(violations.length === 0).toBe(sample.accept);
  });
}
