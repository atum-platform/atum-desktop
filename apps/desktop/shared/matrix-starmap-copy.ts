interface StarmapCopy {
  title: string
  help: string
  skills: string
  memory: string
  chronology: string
  play: string
  pause: string
  scrub: string
  invalidCode: string
}
export const matrixStarmapCopy: Record<'en' | 'vi' | 'ja' | 'zh' | 'zh-hant', StarmapCopy> = {
  en: {
    title: 'Star map',
    help: 'Skills and memories this agent has learned on this Mac.',
    skills: 'Skills',
    memory: 'Memory',
    chronology: 'Core = oldest · outer = newer',
    play: 'Play timeline',
    pause: 'Pause',
    scrub: 'Timeline scrubber',
    invalidCode: 'Could not read that map code.'
  },
  vi: {
    title: 'Bản đồ sao',
    help: 'Kỹ năng và ký ức trợ lý này đã học trên máy Mac này.',
    skills: 'Kỹ năng',
    memory: 'Ký ức',
    chronology: 'Tâm = cũ nhất · ngoài = mới hơn',
    play: 'Phát dòng thời gian',
    pause: 'Tạm dừng',
    scrub: 'Thanh dòng thời gian',
    invalidCode: 'Không đọc được mã bản đồ này.'
  },
  ja: {
    title: '星図',
    help: 'このMacでこのアシスタントが学んだスキルと記憶。',
    skills: 'スキル',
    memory: '記憶',
    chronology: '中心 = 最も古い · 外側 = 新しい',
    play: 'タイムラインを再生',
    pause: '一時停止',
    scrub: 'タイムラインの位置',
    invalidCode: 'この星図コードを読み込めませんでした。'
  },
  zh: {
    title: '星图',
    help: '此助手在这台Mac上学到的技能与记忆。',
    skills: '技能',
    memory: '记忆',
    chronology: '中心 = 最早 · 外侧 = 较新',
    play: '播放时间线',
    pause: '暂停',
    scrub: '时间线滑块',
    invalidCode: '无法读取此星图代码。'
  },
  'zh-hant': {
    title: '星圖',
    help: '此助手在這台Mac上學到的技能與記憶。',
    skills: '技能',
    memory: '記憶',
    chronology: '中心 = 最早 · 外側 = 較新',
    play: '播放時間軸',
    pause: '暫停',
    scrub: '時間軸滑桿',
    invalidCode: '無法讀取此星圖代碼。'
  }
}
