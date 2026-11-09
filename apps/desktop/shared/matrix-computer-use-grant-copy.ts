const words = {
  en: {
    title: 'Request CuaDriver permissions?',
    request: 'Request permissions',
    cancel: 'Cancel',
    local: 'On this Mac',
    detail: 'macOS will ask you to let CuaDriver see your screen and control this Mac for your assistant.'
  },
  vi: {
    title: 'Yêu cầu quyền cho CuaDriver?',
    request: 'Yêu cầu quyền',
    cancel: 'Hủy',
    local: 'Trên máy Mac này',
    detail: 'macOS sẽ hỏi bạn có cho phép CuaDriver xem màn hình và điều khiển máy Mac này cho trợ lý hay không.'
  },
  ja: {
    title: 'CuaDriver のアクセス許可をリクエストしますか？',
    request: '許可をリクエスト',
    cancel: 'キャンセル',
    local: 'この Mac',
    detail: 'macOS が、アシスタントのために CuaDriver が画面を見てこの Mac を操作することを許可するか確認します。'
  },
  zh: {
    title: '请求 CuaDriver 权限？',
    request: '请求权限',
    cancel: '取消',
    local: '此 Mac',
    detail: 'macOS 会询问你是否允许 CuaDriver 为助手查看屏幕并控制这台 Mac。'
  },
  'zh-hant': {
    title: '請求 CuaDriver 權限？',
    request: '請求權限',
    cancel: '取消',
    local: '此 Mac',
    detail: 'macOS 會詢問你是否允許 CuaDriver 為助理查看螢幕並控制這台 Mac。'
  }
}

/** All permission intent comes from native-owned copy and selected-agent scope. */
export function matrixComputerUseGrantConfirmationCopy(locale: string, agentName: string) {
  const c = Object.hasOwn(words, locale) ? words[locale as keyof typeof words] : words.en
  const agent = agentName.replace(/[\p{Cc}]/gu, ' ').slice(0, 200)

  return { title: c.title, request: c.request, cancel: c.cancel, detail: `${agent} · ${c.local}\n\n${c.detail}` }
}
