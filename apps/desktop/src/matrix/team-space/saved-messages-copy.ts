import { useI18n } from '@/i18n'

export interface SavedMessagesCopy {
  title: string
  save: string
  remove: string
  marker: string
  emptyTitle: string
  emptyBody: string
  loading: string
  unavailable: string
  unavailableBody: string
  open: string
  retry: string
  failed: string
  you: string
}

const en: SavedMessagesCopy = {
  title: 'Saved',
  save: 'Save message',
  remove: 'Remove from Saved',
  marker: 'Saved',
  emptyTitle: 'No saved messages',
  emptyBody: 'Save a message from its menu to find it here.',
  loading: 'Loading saved messages',
  unavailable: 'Message unavailable',
  unavailableBody: 'It was deleted or you no longer have access.',
  open: 'Jump to message',
  retry: 'Try again',
  failed: 'Saved messages aren’t available right now.',
  you: 'You'
}

const vi: SavedMessagesCopy = {
  title: 'Đã lưu',
  save: 'Lưu tin nhắn',
  remove: 'Bỏ khỏi Đã lưu',
  marker: 'Đã lưu',
  emptyTitle: 'Chưa có tin nhắn đã lưu',
  emptyBody: 'Lưu một tin nhắn từ menu để tìm lại tại đây.',
  loading: 'Đang tải tin nhắn đã lưu',
  unavailable: 'Không còn xem được tin nhắn',
  unavailableBody: 'Tin nhắn đã bị xóa hoặc bạn không còn quyền truy cập.',
  open: 'Đi đến tin nhắn',
  retry: 'Thử lại',
  failed: 'Hiện chưa tải được tin nhắn đã lưu.',
  you: 'Bạn'
}

export function savedMessagesCopy(locale: string): SavedMessagesCopy {
  return locale === 'vi' ? vi : en
}

export function useSavedMessagesCopy(): SavedMessagesCopy {
  return savedMessagesCopy(useI18n().locale)
}
