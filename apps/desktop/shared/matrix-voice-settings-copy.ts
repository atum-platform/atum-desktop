import type { MatrixVoiceSettingKey, MatrixVoiceSettingsConfirmation } from './matrix-voice-settings'

interface VoiceSettingsCopy {
  title: string
  help: string
  apply: string
  cancel: string
  refresh: string
  choose: string
  saved: string
  unknown: string
  applied: string
  cancelled: string
  failed: string
  empty: string
  confirm: string
  stt: string
  tts: string
  enabled: string
  duration: string
  local: string
  names: Record<string, string>
}
export const matrixVoiceSettingsCopy: Record<'en' | 'vi' | 'ja' | 'zh' | 'zh-hant', VoiceSettingsCopy> = {
  en: {
    title: 'Voice',
    help: 'Settings apply to your next recording or read-aloud. Audio starts only when you ask. Provider usage may have a cost.',
    apply: 'Apply',
    cancel: 'Cancel',
    refresh: 'Refresh',
    choose: 'Choose',
    saved: 'Saved',
    unknown: 'Unknown',
    applied: 'Voice setting updated.',
    cancelled: 'Change cancelled.',
    failed: 'Could not verify voice settings. Refresh and try again.',
    empty: 'This runtime does not expose editable voice settings.',
    confirm: 'Change this voice setting?',
    stt: 'Dictation provider',
    tts: 'Read-aloud provider',
    enabled: 'Enable dictation',
    duration: 'Maximum recording seconds',
    local: 'Local',
    names: {
      model: 'Model',
      model_id: 'Model',
      voice: 'Voice',
      voice_id: 'Voice',
      language: 'Language',
      language_code: 'Language',
      speed: 'Speed',
      auto_speech_tags: 'Expressive speech tags',
      optimize_streaming_latency: 'Streaming latency',
      sample_rate: 'Sample rate',
      bit_rate: 'Bitrate',
      device: 'Device',
      tag_audio_events: 'Tag audio events',
      diarize: 'Speaker labels',
      audio_tags: 'Speech tags'
    }
  },
  vi: {
    title: 'Giọng nói',
    help: 'Cài đặt áp dụng cho lần ghi âm hoặc đọc thành tiếng tiếp theo. Âm thanh chỉ bắt đầu khi bạn yêu cầu. Nhà cung cấp có thể tính phí sử dụng.',
    apply: 'Áp dụng',
    cancel: 'Hủy',
    refresh: 'Làm mới',
    choose: 'Chọn',
    saved: 'Đã lưu',
    unknown: 'Chưa rõ',
    applied: 'Đã cập nhật cài đặt giọng nói.',
    cancelled: 'Đã hủy thay đổi.',
    failed: 'Không thể xác minh cài đặt giọng nói. Hãy làm mới và thử lại.',
    empty: 'Môi trường này chưa có cài đặt giọng nói có thể chỉnh sửa.',
    confirm: 'Đổi cài đặt giọng nói này?',
    stt: 'Nhà cung cấp nhập giọng nói',
    tts: 'Nhà cung cấp đọc thành tiếng',
    enabled: 'Bật nhập giọng nói',
    duration: 'Số giây ghi âm tối đa',
    local: 'Cục bộ',
    names: {
      model: 'Mô hình',
      model_id: 'Mô hình',
      voice: 'Giọng',
      voice_id: 'Giọng',
      language: 'Ngôn ngữ',
      language_code: 'Ngôn ngữ',
      speed: 'Tốc độ',
      auto_speech_tags: 'Thẻ giọng nói biểu cảm',
      optimize_streaming_latency: 'Độ trễ phát trực tiếp',
      sample_rate: 'Tần số lấy mẫu',
      bit_rate: 'Tốc độ bit',
      device: 'Thiết bị',
      tag_audio_events: 'Gắn thẻ sự kiện âm thanh',
      diarize: 'Nhãn người nói',
      audio_tags: 'Thẻ giọng nói'
    }
  },
  ja: {
    title: '音声',
    help: '次の録音や読み上げから適用されます。音声は操作した時だけ開始します。プロバイダーの利用には料金がかかる場合があります。',
    apply: '適用',
    cancel: 'キャンセル',
    refresh: '更新',
    choose: '選択',
    saved: '保存済み',
    unknown: '不明',
    applied: '音声設定を更新しました。',
    cancelled: '変更をキャンセルしました。',
    failed: '音声設定を確認できませんでした。更新して再試行してください。',
    empty: 'このランタイムには編集できる音声設定がありません。',
    confirm: 'この音声設定を変更しますか？',
    stt: '音声入力プロバイダー',
    tts: '読み上げプロバイダー',
    enabled: '音声入力を有効にする',
    duration: '最大録音秒数',
    local: 'ローカル',
    names: {
      model: 'モデル',
      model_id: 'モデル',
      voice: '音声',
      voice_id: '音声',
      language: '言語',
      language_code: '言語',
      speed: '速度',
      auto_speech_tags: '表現音声タグ',
      optimize_streaming_latency: '配信の遅延',
      sample_rate: 'サンプルレート',
      bit_rate: 'ビットレート',
      device: 'デバイス',
      tag_audio_events: '音声イベントのタグ',
      diarize: '話者ラベル',
      audio_tags: '音声タグ'
    }
  },
  zh: {
    title: '语音',
    help: '设置应用于下一次录音或朗读。只有你操作时才会开始音频。服务可能收取使用费用。',
    apply: '应用',
    cancel: '取消',
    refresh: '刷新',
    choose: '选择',
    saved: '已保存',
    unknown: '未知',
    applied: '已更新语音设置。',
    cancelled: '已取消更改。',
    failed: '无法验证语音设置。请刷新后重试。',
    empty: '此运行环境没有可编辑的语音设置。',
    confirm: '更改此语音设置？',
    stt: '语音输入服务',
    tts: '朗读服务',
    enabled: '启用语音输入',
    duration: '最长录音秒数',
    local: '本地',
    names: {
      model: '模型',
      model_id: '模型',
      voice: '声音',
      voice_id: '声音',
      language: '语言',
      language_code: '语言',
      speed: '速度',
      auto_speech_tags: '表达语音标签',
      optimize_streaming_latency: '流式延迟',
      sample_rate: '采样率',
      bit_rate: '比特率',
      device: '设备',
      tag_audio_events: '音频事件标签',
      diarize: '说话人标签',
      audio_tags: '语音标签'
    }
  },
  'zh-hant': {
    title: '語音',
    help: '設定套用於下一次錄音或朗讀。只有你操作時才會開始音訊。服務可能收取使用費用。',
    apply: '套用',
    cancel: '取消',
    refresh: '重新整理',
    choose: '選擇',
    saved: '已儲存',
    unknown: '未知',
    applied: '已更新語音設定。',
    cancelled: '已取消變更。',
    failed: '無法驗證語音設定。請重新整理後再試。',
    empty: '此執行環境沒有可編輯的語音設定。',
    confirm: '變更此語音設定？',
    stt: '語音輸入服務',
    tts: '朗讀服務',
    enabled: '啟用語音輸入',
    duration: '最長錄音秒數',
    local: '本機',
    names: {
      model: '模型',
      model_id: '模型',
      voice: '聲音',
      voice_id: '聲音',
      language: '語言',
      language_code: '語言',
      speed: '速度',
      auto_speech_tags: '表達語音標籤',
      optimize_streaming_latency: '串流延遲',
      sample_rate: '取樣率',
      bit_rate: '位元率',
      device: '裝置',
      tag_audio_events: '音訊事件標籤',
      diarize: '說話者標籤',
      audio_tags: '語音標籤'
    }
  }
}
export function matrixVoiceFieldLabel(locale: string, field: MatrixVoiceSettingKey): string {
  const c = matrixVoiceSettingsCopy[locale as keyof typeof matrixVoiceSettingsCopy] ?? matrixVoiceSettingsCopy.en
  const general: Partial<Record<MatrixVoiceSettingKey, string>> = {
    'stt.enabled': c.enabled,
    'stt.provider': c.stt,
    'tts.provider': c.tts,
    'voice.max_recording_seconds': c.duration
  }
  if (general[field]) return general[field]!
  const [, provider, name] = field.split('.')
  const brands: Record<string, string> = {
    openai: 'OpenAI',
    elevenlabs: 'ElevenLabs',
    xai: 'xAI',
    deepinfra: 'DeepInfra',
    neutts: 'NeuTTS',
    kittentts: 'KittenTTS',
    piper: 'Piper',
    mistral: 'Mistral',
    minimax: 'MiniMax',
    gemini: 'Gemini',
    edge: 'Edge',
    local: c.local
  }
  return `${brands[provider] ?? provider} · ${c.names[name] ?? name}`
}
export function matrixVoiceSettingsConfirmationCopy(
  locale: string,
  agent: string,
  request: MatrixVoiceSettingsConfirmation
) {
  const c = matrixVoiceSettingsCopy[locale as keyof typeof matrixVoiceSettingsCopy] ?? matrixVoiceSettingsCopy.en
  return {
    title: c.confirm,
    apply: c.apply,
    cancel: c.cancel,
    detail: `${agent}\n${matrixVoiceFieldLabel(locale, request.field)}: ${request.value}\n\n${c.help}`
  }
}
