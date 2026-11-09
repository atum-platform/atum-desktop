import { type Locale, useI18n } from '@/i18n'

import type { GroupCandidateBlock, GroupPickerFilter } from './group-picker-model'

/** The group picker: making a group, and adding members to one. Five locales, changed
 * together; Vietnamese is the default. The lookup's own lines (searching, not found, …)
 * stay in `roster-create-copy.ts`, shared with adding a friend. */
const en = {
  createTitle: 'New group',
  addTitle: 'Add members',
  addMembers: 'Add members',
  groupName: 'Group name',
  groupNamePlaceholder: 'Name the group…',
  search: 'Search names, or enter an @name',
  filters: 'Show',
  filter: {
    all: 'All',
    person: 'People',
    assistant: 'Assistants',
    app: 'Apps'
  } satisfies Record<GroupPickerFilter, string>,
  recent: 'Recent chats',
  selected: (count: number) => (count === 1 ? '1 selected' : `${count} selected`),
  remove: (name: string) => `Remove ${name}`,
  block: {
    assistantNotReady: 'Not ready yet',
    agentsFull: 'Up to 5 assistants in a group',
    appSoon: 'Coming to groups soon',
    appConnect: 'Connect this app first',
    appUnavailable: 'Not available right now',
    appAlone: 'Not with the app you picked',
    appWithPeople: 'Only in a group of just you and this app',
    appNewGroupOnly: 'Only when making a new group',
    member: 'Already in this group',
    full: 'Up to 20 people at a time'
  } satisfies Record<GroupCandidateBlock, string>,
  assistantsNote:
    'Only you can ask your assistants here, and everyone can read their answers. In a group with only your assistants, relevant ones may join without being named. Your message, their work descriptions, a quoted message, and recent group messages may go to AI services to choose and prepare replies.',
  appGroupNote: 'A group with this app is just you and the app.',
  nothingYet: 'People you message, your assistants and your apps show up here.',
  noMatches: 'No matches',
  add: (count: number) => (count > 0 ? `Add ${count}` : 'Add'),
  adding: 'Adding…',
  addFailed: "Couldn't add everyone. Try again."
}

type GroupPickerCopy = typeof en

const vi: GroupPickerCopy = {
  createTitle: 'Tạo nhóm',
  addTitle: 'Thêm thành viên',
  addMembers: 'Thêm thành viên',
  groupName: 'Tên nhóm',
  groupNamePlaceholder: 'Nhập tên nhóm…',
  search: 'Nhập tên hoặc @tên',
  filters: 'Hiển thị',
  filter: { all: 'Tất cả', person: 'Người', assistant: 'Trợ lý', app: 'Ứng dụng' },
  recent: 'Trò chuyện gần đây',
  selected: count => `Đã chọn ${count}`,
  remove: name => `Bỏ chọn ${name}`,
  block: {
    assistantNotReady: 'Chưa sẵn sàng',
    agentsFull: 'Tối đa 5 trợ lý trong một nhóm',
    appSoon: 'Sắp có thể thêm vào nhóm',
    appConnect: 'Hãy kết nối ứng dụng trước',
    appUnavailable: 'Hiện chưa dùng được',
    appAlone: 'Không chọn chung với ứng dụng đã chọn',
    appWithPeople: 'Chỉ trong nhóm riêng của bạn với ứng dụng',
    appNewGroupOnly: 'Chỉ thêm được khi tạo nhóm mới',
    member: 'Đã ở trong nhóm',
    full: 'Tối đa 20 người mỗi lần'
  },
  assistantsNote:
    'Chỉ bạn nhờ được trợ lý của mình trong nhóm, và mọi người đều đọc được câu trả lời. Trong nhóm chỉ có bạn và các trợ lý, trợ lý phù hợp có thể tham gia dù không được gọi tên. Tin nhắn của bạn, mô tả công việc của trợ lý, một tin được trích dẫn và các tin gần đây có thể được gửi tới dịch vụ AI để chọn và soạn câu trả lời.',
  appGroupNote: 'Nhóm với ứng dụng này chỉ gồm bạn và ứng dụng.',
  nothingYet: 'Những người bạn nhắn tin, trợ lý và ứng dụng của bạn sẽ hiện ở đây.',
  noMatches: 'Không có kết quả phù hợp',
  add: count => (count > 0 ? `Thêm ${count}` : 'Thêm'),
  adding: 'Đang thêm…',
  addFailed: 'Chưa thêm được hết mọi người. Hãy thử lại.'
}

const ja: GroupPickerCopy = {
  createTitle: 'グループを作成',
  addTitle: 'メンバーを追加',
  addMembers: 'メンバーを追加',
  groupName: 'グループ名',
  groupNamePlaceholder: 'グループ名を入力…',
  search: '名前を検索、または @名前 を入力',
  filters: '表示',
  filter: { all: 'すべて', person: '人', assistant: 'アシスタント', app: 'アプリ' },
  recent: '最近のチャット',
  selected: count => `${count} 件選択中`,
  remove: name => `${name} を外す`,
  block: {
    assistantNotReady: 'まだ準備できていません',
    agentsFull: '1 つのグループにアシスタントは 5 人までです',
    appSoon: 'まもなくグループに参加できます',
    appConnect: '先にこのアプリを接続してください',
    appUnavailable: '現在は利用できません',
    appAlone: '選んだアプリとは一緒に追加できません',
    appWithPeople: '自分とこのアプリだけのグループでのみ使えます',
    appNewGroupOnly: '新しいグループを作るときだけ追加できます',
    member: 'すでにこのグループにいます',
    full: '一度に追加できるのは 20 人までです'
  },
  assistantsNote:
    'このグループでアシスタントに頼めるのはあなただけで、返信は全員が読めます。あなたとアシスタントだけのグループでは、名前を呼ばなくても関連するアシスタントが参加することがあります。返信するアシスタントを選んで回答を作るため、あなたのメッセージ、仕事の説明、引用したメッセージ、最近のグループメッセージが AI サービスに送られることがあります。',
  appGroupNote: 'このアプリとのグループは、あなたとアプリだけです。',
  nothingYet: 'メッセージした人、アシスタント、アプリがここに表示されます。',
  noMatches: '一致する項目はありません',
  add: count => (count > 0 ? `${count} 件を追加` : '追加'),
  adding: '追加中…',
  addFailed: '全員を追加できませんでした。もう一度お試しください。'
}

const zh: GroupPickerCopy = {
  createTitle: '创建群组',
  addTitle: '添加成员',
  addMembers: '添加成员',
  groupName: '群组名称',
  groupNamePlaceholder: '输入群组名称…',
  search: '搜索名字，或输入 @名称',
  filters: '显示',
  filter: { all: '全部', person: '联系人', assistant: '助理', app: '应用' },
  recent: '最近聊天',
  selected: count => `已选 ${count} 个`,
  remove: name => `移除 ${name}`,
  block: {
    assistantNotReady: '还没准备好',
    agentsFull: '一个群组最多 5 位助理',
    appSoon: '即将可以加入群组',
    appConnect: '请先连接这个应用',
    appUnavailable: '暂时无法使用',
    appAlone: '不能和已选的应用一起添加',
    appWithPeople: '只能用于只有你和这个应用的群组',
    appNewGroupOnly: '只能在创建新群组时添加',
    member: '已在这个群组中',
    full: '一次最多 20 人'
  },
  assistantsNote:
    '只有你能请自己的助理帮忙，群组里的所有人都能看到回复。在只有你和助理的群组中，即使没有点名，相关助理也可能参与。为了选择助理并准备回复，你的消息、助理的工作说明、一条引用消息和最近的群聊消息可能会发送给 AI 服务。',
  appGroupNote: '与这个应用的群组只有你和这个应用。',
  nothingYet: '你发过消息的人、你的助理和应用会显示在这里。',
  noMatches: '没有匹配的结果',
  add: count => (count > 0 ? `添加 ${count} 个` : '添加'),
  adding: '正在添加…',
  addFailed: '未能全部添加，请再试一次。'
}

const zhHant: GroupPickerCopy = {
  createTitle: '建立群組',
  addTitle: '新增成員',
  addMembers: '新增成員',
  groupName: '群組名稱',
  groupNamePlaceholder: '輸入群組名稱…',
  search: '搜尋名字，或輸入 @名稱',
  filters: '顯示',
  filter: { all: '全部', person: '聯絡人', assistant: '助理', app: '應用程式' },
  recent: '最近的聊天',
  selected: count => `已選 ${count} 個`,
  remove: name => `移除 ${name}`,
  block: {
    assistantNotReady: '還沒準備好',
    agentsFull: '一個群組最多 5 位助理',
    appSoon: '即將可以加入群組',
    appConnect: '請先連接這個應用程式',
    appUnavailable: '暫時無法使用',
    appAlone: '不能和已選的應用程式一起新增',
    appWithPeople: '只能用於只有你和這個應用程式的群組',
    appNewGroupOnly: '只能在建立新群組時新增',
    member: '已在這個群組中',
    full: '一次最多 20 人'
  },
  assistantsNote:
    '只有你能請自己的助理幫忙，群組裡的所有人都能看到回覆。在只有你和助理的群組中，即使沒有點名，相關助理也可能參與。為了選擇助理並準備回覆，你的訊息、助理的工作說明、一則引用訊息和最近的群組訊息可能會傳送給 AI 服務。',
  appGroupNote: '與這個應用程式的群組只有你和這個應用程式。',
  nothingYet: '你傳過訊息的人、你的助理和應用程式會顯示在這裡。',
  noMatches: '沒有相符的結果',
  add: count => (count > 0 ? `新增 ${count} 個` : '新增'),
  adding: '正在新增…',
  addFailed: '未能全部新增，請再試一次。'
}

const copies: Record<Locale, GroupPickerCopy> = { en, vi, ja, zh, 'zh-hant': zhHant }

export function groupPickerCopy(locale: Locale): GroupPickerCopy {
  return copies[locale] ?? en
}

export function useGroupPickerCopy(): GroupPickerCopy {
  return groupPickerCopy(useI18n().locale)
}
