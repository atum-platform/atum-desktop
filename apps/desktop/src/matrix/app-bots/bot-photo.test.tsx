import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixBotApiPhoto } from '../../../shared/matrix'

import { MatrixBotApiPhotoView } from './bot-photo'

const photo = {
  fileRef: 'mref_0123456789abcdef',
  width: 1_280,
  height: 960,
  mimeType: 'image/jpeg' as const,
  caption: 'Please inspect this'
}

const loaded: MatrixBotApiPhoto = {
  url: 'data:image/jpeg;base64,ZmFrZQ==',
  width: 1_280,
  height: 960,
  mimeType: 'image/jpeg'
}

function frame(element: React.ReactNode, locale = 'en') {
  return (
    <I18nProvider configClient={null} initialLocale={locale}>
      {element}
    </I18nProvider>
  )
}

afterEach(cleanup)

describe('bot-api photo', () => {
  it('shows the image, its caption and a full view', async () => {
    const media = vi.fn(async () => loaded)
    render(
      frame(
        <MatrixBotApiPhotoView
          appId="app-1"
          body="Please inspect this"
          caption={photo.caption}
          eventId="$event"
          locale="en"
          media={media}
          photo={photo}
          roomId="!room:test"
        />
      )
    )

    const image = await screen.findByRole('img', { name: 'Please inspect this' })
    expect(image).toHaveProperty('src', loaded.url)
    expect(screen.getByText('Please inspect this')).toBeTruthy()
    expect(media).toHaveBeenCalledWith({ appId: 'app-1', roomId: '!room:test', eventId: '$event' })

    fireEvent.click(screen.getByRole('button', { name: 'Open photo' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(within(screen.getByRole('dialog')).getByRole('img', { name: 'Please inspect this' })).toBeTruthy()
  })

  it('keeps the message text when a photo is unavailable rather than leaving a broken image', async () => {
    render(
      frame(
        <MatrixBotApiPhotoView
          appId="app-1"
          body="The original photo caption"
          eventId="$redacted"
          locale="en"
          media={async () => null}
          photo={photo}
          roomId="!room:test"
        />
      )
    )

    expect(await screen.findByText('Photo unavailable')).toBeTruthy()
    expect(screen.getByText('The original photo caption')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it.each([
    ['vi', 'Không tải được ảnh'],
    ['ja', '写真を表示できません'],
    ['zh', '照片不可用'],
    ['zh-hant', '照片無法使用']
  ])('speaks %s', async (locale, text) => {
    render(
      frame(
        <MatrixBotApiPhotoView
          appId="app-1"
          body="Photo"
          eventId={`$missing-${locale}`}
          locale={locale}
          media={async () => null}
          photo={photo}
          roomId="!room:test"
        />
      )
    )

    expect(await screen.findByText(text)).toBeTruthy()
  })

  it('renders a URL button carried as a labelled formatted-body link beside the photo', async () => {
    const open = vi.fn(async () => {})
    window.atumMatrix = { openLink: open } as unknown as typeof window.atumMatrix
    render(
      frame(
        <MatrixBotApiPhotoView
          appId="app-1"
          body="Sign in"
          eventId="$link"
          formattedBody={'<a href="https://moon.example/sign-in#account">Sign in to Moon</a>'}
          locale="en"
          media={async () => loaded}
          photo={photo}
          roomId="!room:test"
        />
      )
    )

    fireEvent.click(await screen.findByRole('link', { name: 'Sign in to Moon' }))
    expect(open).toHaveBeenCalledWith('https://moon.example/sign-in#account')
  })
})
