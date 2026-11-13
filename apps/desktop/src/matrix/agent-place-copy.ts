/** Read-only place and Mac reach labels retained after relocation retirement. */
const words = {
en: {
rowTitle: 'Lives on',
livesWhere: 'Lives on',
canUse: 'Can use',
noMac: 'No Mac yet',
title: 'Where it lives',
cloudPlace: 'The cloud',
thisMac: 'This Mac'
},
vi: {
rowTitle: 'Đang ở trên',
livesWhere: 'Đang ở trên',
canUse: 'Dùng được',
noMac: 'Chưa có máy Mac',
title: 'Trợ lý đang ở đâu',
cloudPlace: 'Đám mây',
thisMac: 'Máy này'
},
ja: {
rowTitle: 'いる場所',
livesWhere: '現在の場所',
canUse: '使える Mac',
noMac: 'まだ Mac がありません',
title: 'アシスタントがいる場所',
cloudPlace: 'クラウド',
thisMac: 'この Mac'
},
zh: {
rowTitle: '所在位置',
livesWhere: '目前位置',
canUse: '可使用',
noMac: '还没有 Mac',
title: '助手所在的位置',
cloudPlace: '云端',
thisMac: '这台 Mac'
},
'zh-hant': {
rowTitle: '所在位置',
livesWhere: '目前位置',
canUse: '可使用',
noMac: '還沒有 Mac',
title: '助理所在的位置',
cloudPlace: '雲端',
thisMac: '這部 Mac'
},
}
export function agentPlaceCopy(locale: string) { return words[locale as keyof typeof words] ?? words.en }
