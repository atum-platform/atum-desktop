import { describe, expect, it } from 'vitest'

import {
  assertPublicResolvedAddresses,
  assertSafeBrowserRequestUrl,
  assertSafeBrowserUrl,
  clampBrowserBounds,
  normalizeBrowserInput
} from './policy'

describe('consumer browser network policy', () => {
  it('normalizes domains and searches', () => {
    expect(normalizeBrowserInput('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserInput('weather in Đà Nẵng')).toBe(
      'https://www.google.com/search?q=weather%20in%20%C4%90%C3%A0%20N%E1%BA%B5ng'
    )
    expect(normalizeBrowserInput('about:blank')).toBe('about:blank')
  })

  it('blocks privileged, credential-bearing, loopback, and private URLs', () => {
    for (const value of [
      'file:///etc/passwd',
      'https://user:secret@example.com',
      'http://localhost:3000',
      'http://127.0.0.1',
      'http://10.0.0.1',
      'http://172.16.0.1',
      'http://192.168.1.1',
      'http://[::1]',
      'http://host.docker.internal'
    ]) {
      expect(() => assertSafeBrowserUrl(value), value).toThrow(/browser_url_blocked/u)
    }

    expect(assertSafeBrowserUrl('https://example.com/path')).toBe('https://example.com/path')
  })

  it('blocks private IPv4 destinations hidden in IPv6', () => {
    for (const value of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:a9fe:101]/',
      'http://[::a00:1]/',
      'http://[64:ff9b::c0a8:101]/',
      'http://[::ffff:0:7f00:1]/',
      'http://[64:ff9b:1::a00:1]/',
      'http://[2002:7f00:1::1]/',
      'http://[2002:7f00::1]/',
      'http://[2002:a00::1]/',
      'http://[2002:c0a8::1]/',
      'http://[2001:0:808:808:0:0:f5ff:fffe]/',
      'http://[2001:0:a00:1:0:0:f7f7:f7f7]/',
      'http://[ff02::1]/'
    ]) {
      expect(() => assertSafeBrowserUrl(value), value).toThrow(/browser_url_blocked/u)
    }

    expect(assertSafeBrowserUrl('https://[2606:4700:4700::1111]/')).toBe('https://[2606:4700:4700::1111]/')
  })

  it('rejects DNS answer sets containing any non-public address', () => {
    expect(() => assertPublicResolvedAddresses(['93.184.216.34', '2606:4700:4700::1111'])).not.toThrow()

    for (const address of [
      '127.0.0.1',
      '::ffff:127.0.0.1',
      '2002:7f00:1::1',
      '2002:7f00::1',
      '2002:a00::1',
      '2002:c0a8::1',
      '2001:0:808:808:0:0:f5ff:fffe',
      '0:0:0:0:0:0:0:1',
      'not-an-ip'
    ]) {
      expect(() => assertPublicResolvedAddresses(['93.184.216.34', address]), address).toThrow(/browser_url_blocked/u)
    }

    expect(() => assertPublicResolvedAddresses([])).toThrow(/browser_url_blocked/u)
  })

  it('allows request WebSockets but rejects direct reserved networks', () => {
    expect(assertSafeBrowserRequestUrl('wss://example.com/socket')).toBe('wss://example.com/socket')

    for (const value of [
      'ws://127.0.0.1/socket',
      'wss://192.0.2.10/socket',
      'https://198.18.0.1/',
      'https://198.51.100.1/',
      'https://203.0.113.1/'
    ]) {
      expect(() => assertSafeBrowserRequestUrl(value), value).toThrow(/browser_url_blocked/u)
    }
  })

  it('searches ambiguous dotted numbers and clamps geometry', () => {
    expect(normalizeBrowserInput('1.5')).toBe('https://www.google.com/search?q=1.5')
    expect(normalizeBrowserInput('8.8.8.8')).toBe('https://8.8.8.8/')
    expect(() => normalizeBrowserInput('10.0.0.5:8080')).toThrow(/browser_url_blocked/u)
    expect(clampBrowserBounds({ x: 900, y: 100, width: 800, height: 900 }, { width: 1_200, height: 800 })).toEqual({
      x: 900,
      y: 100,
      width: 300,
      height: 700
    })
  })
})
