import { describe, expect, it } from 'vitest'

import type { ExecutionDeviceName } from '../../shared/execution-policy'
import { executionPolicyDestinationViews } from '../../shared/execution-policy'

import { executionDeviceRealName, withoutDevicePossessive } from './execution-device-name'
import { executionMachineName } from './execution-machines-copy'

const MAC_A = 'mac:00000000-0000-4000-8000-b454f82c5857'
const MAC_B = 'mac:00000000-0000-4000-8000-f6222a1106ee'

const device = (displayName: string, model?: string, thisMac = false): ExecutionDeviceName => ({
  displayName,
  ...(model ? { model } : {}),
  thisMac
})

const destinations = executionPolicyDestinationViews({ order: ['cloud', MAC_A, MAC_B], disabled: [] })
const macA = destinations.find(destination => destination.id === MAC_A)!
const macB = destinations.find(destination => destination.id === MAC_B)!

describe('execution device names (§9.4 “Real names”)', () => {
  it('drops the owner’s possessive from the Computer Name', () => {
    expect(withoutDevicePossessive("Owner's MacBook Air")).toBe('MacBook Air')
    expect(withoutDevicePossessive('Owner’s MacBook Air')).toBe('MacBook Air')
    expect(withoutDevicePossessive("Owner's MacBook Pro")).toBe('MacBook Pro')
    expect(withoutDevicePossessive("Owner's MacBook")).toBe('MacBook')
    expect(withoutDevicePossessive("Owner's Mac mini")).toBe('Mac mini')
    expect(withoutDevicePossessive("Owner's Mac Studio")).toBe('Mac Studio')
    expect(withoutDevicePossessive("Owner's Mac Pro")).toBe('Mac Pro')
    expect(withoutDevicePossessive("Minh's iMac")).toBe('iMac')
    expect(withoutDevicePossessive('Mac mini của Example')).toBe('Mac mini')
    expect(withoutDevicePossessive('  Mac mini  ')).toBe('Mac mini')
  })

  it('keeps a name whose apostrophe is not an owner possessive', () => {
    // "Mac's Pro" is the Mac's name, not "<owner> Mac's " + something: stripping would leave "Pro".
    expect(withoutDevicePossessive("Mac's Pro")).toBe("Mac's Pro")
    expect(withoutDevicePossessive("Minh's Pro")).toBe("Minh's Pro")
    expect(withoutDevicePossessive("Stu's laptop")).toBe("Stu's laptop")
    // A model name must still follow the possessive, so a suffix keeps the whole name.
    expect(withoutDevicePossessive("Owner's MacBook Pro (Work)")).toBe('MacBook Pro (Work)')
  })

  it('falls back to the model, and to nothing when even that is missing', () => {
    expect(executionDeviceRealName(device('   ', 'MacBook Air'))).toBe('MacBook Air')
    expect(executionDeviceRealName(device('', 'Mac mini'))).toBe('Mac mini')
    expect(executionDeviceRealName(device(''))).toBeUndefined()
  })

  it('names the Mac in the owner’s language, with this Mac marked', () => {
    const names = {
      [MAC_A.slice('mac:'.length)]: device("Example's MacBook Air", 'MacBook Air', true),
      [MAC_B.slice('mac:'.length)]: device("Owner's Mac mini")
    }

    expect(executionMachineName('vi', macA, names)).toBe('MacBook Air (máy này)')
    expect(executionMachineName('en', macB, names)).toBe('Mac mini')
    expect(executionMachineName('en', destinations[0], names)).toBe('Cloud')
  })

  it('keeps the stable ordinal when nothing names the Mac, and when no names cross at all', () => {
    expect(executionMachineName('vi', macB)).toBe('Máy Mac 2')
    expect(executionMachineName('en', macA, { [MAC_A.slice('mac:'.length)]: device('', undefined, true) })).toBe('Mac 1')
  })
})
