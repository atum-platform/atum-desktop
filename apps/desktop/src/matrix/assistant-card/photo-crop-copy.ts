import { type Locale, useI18n } from '@/i18n'

interface PhotoCropCopy {
  title: string
  hint: string
  position: string
  zoom: string
  cancel: string
  use: string
  loading: string
  failed: string
  retry: string
}

const copies: Record<Locale, PhotoCropCopy> = {
  en: {
    title: 'Crop photo', hint: 'Drag the photo to frame it. Use the arrow keys to adjust it.',
    position: 'Photo position', zoom: 'Zoom', cancel: 'Cancel', use: 'Use photo',
    loading: 'Opening photo…', failed: 'Couldn’t open this image. Try a JPEG or PNG.', retry: 'Try again'
  },
  vi: {
    title: 'Cắt ảnh', hint: 'Kéo ảnh để chọn khung. Dùng phím mũi tên để chỉnh vị trí.',
    position: 'Vị trí ảnh', zoom: 'Thu phóng', cancel: 'Hủy', use: 'Dùng ảnh này',
    loading: 'Đang mở ảnh…', failed: 'Chưa mở được ảnh này. Thử ảnh JPEG hoặc PNG nhé.', retry: 'Thử lại'
  },
  ja: {
    title: '写真を切り抜く', hint: '写真をドラッグして位置を調整します。矢印キーでも調整できます。',
    position: '写真の位置', zoom: 'ズーム', cancel: 'キャンセル', use: 'この写真を使う',
    loading: '写真を開いています…', failed: 'この画像を開けませんでした。JPEGまたはPNGをお試しください。', retry: '再試行'
  },
  zh: {
    title: '裁剪照片', hint: '拖动照片调整取景，也可以使用方向键调整位置。',
    position: '照片位置', zoom: '缩放', cancel: '取消', use: '使用照片',
    loading: '正在打开照片…', failed: '无法打开此图片。请尝试JPEG或PNG图片。', retry: '重试'
  },
  'zh-hant': {
    title: '裁切照片', hint: '拖曳照片調整取景，也可以使用方向鍵調整位置。',
    position: '照片位置', zoom: '縮放', cancel: '取消', use: '使用照片',
    loading: '正在開啟照片…', failed: '無法開啟此圖片。請嘗試JPEG或PNG圖片。', retry: '重試'
  }
}

export function usePhotoCropCopy(): PhotoCropCopy {
  return copies[useI18n().locale]
}
