import path from 'node:path'

import { expect, it } from 'vitest'

import { matrixPetRendererModules } from './matrix-pet-composition.mjs'

const root = '/workspace/apps/desktop'
it('allows only presentation modules and ignores framework package locations', () => {
  const ids = ['src/matrix/pet/overlay-root.tsx', 'shared/pet.ts', 'src/components/ui/button.tsx'].map(file =>
    path.join(root, file)
  )
  expect(matrixPetRendererModules([...ids, '/cache/node_modules/react/index.js'], root)).toEqual([
    'shared/pet.ts',
    'src/components/ui/button.tsx',
    'src/matrix/pet/overlay-root.tsx'
  ])
})
it('rejects transport, native, account and general renderer roots in the actual graph', () => {
  for (const file of [
    'electron/matrix/main.ts',
    'src/matrix/sdk-entry.ts',
    'src/store/pet.ts',
    'shared/matrix.ts',
    'src/matrix/app.tsx'
  ]) {
    expect(() => matrixPetRendererModules([path.join(root, file)], root)).toThrow('matrix_pet_composition_denied')
  }
  expect(() => matrixPetRendererModules(['/cache/node_modules/matrix-js-sdk/src/client.js'], root)).toThrow(
    'matrix_pet_composition_denied'
  )
})
it('allows the pet chat box and its shared presentation, recording the kit icons by package name', () => {
  const ids = [
    'src/matrix/pet/chat-box.tsx',
    'src/matrix/pet/pet-face.tsx',
    'src/matrix/message-time.ts',
    'src/lib/icons.ts',
    'src/app/chat/composer/composer-surface.tsx'
  ].map(file => path.join(root, file))
  expect(
    matrixPetRendererModules(
      [...ids, '/workspace/packages/atum-kit/src/icon.tsx', '/workspace/packages/atum-kit/dist/phosphor-icons.json'],
      root
    )
  ).toEqual([
    '@atum/kit/dist/phosphor-icons.json',
    '@atum/kit/src/icon.tsx',
    'src/app/chat/composer/composer-surface.tsx',
    'src/lib/icons.ts',
    'src/matrix/message-time.ts',
    'src/matrix/pet/chat-box.tsx',
    'src/matrix/pet/pet-face.tsx'
  ])
})
it('still rejects the rest of the kit, other workspace packages and the general chat', () => {
  for (const id of [
    '/workspace/packages/atum-kit/src/tokens.ts',
    '/workspace/packages/device-protocol/index.ts',
    '/workspace/apps/shared/src/json-rpc-gateway.ts',
    path.join(root, 'src/app/chat/composer/index.tsx'),
    path.join(root, 'src/matrix/pet/glass-chat.tsx')
  ]) {
    expect(() => matrixPetRendererModules([id], root)).toThrow('matrix_pet_composition_denied')
  }
})
