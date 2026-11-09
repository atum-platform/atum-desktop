import { type Locale, useI18n } from '@/i18n'

const en = {
  /** Someone who set no name and whose @handle is not known here. */
  unnamed: 'Atum user',
  members: 'Members',
  invited: 'Invited',
  joined: 'Joined',
  remove: 'Remove',
  confirmRemove: 'Confirm removal',
  cancel: 'Cancel',
  leave: 'Leave conversation',
  confirmLeave: 'Confirm leave',
  decline: 'Decline invitation',
  confirmDecline: 'Confirm decline',
  accept: 'Accept invitation',
  historyNotice: 'Leaving or removal stops future participation. Messages already received cannot be taken back.',
  noMembership: 'You are no longer a member. Previously received messages remain readable.',
  cannotSend: 'Your current room permissions do not allow sending.',
  error: 'Could not complete this action. Your input is kept; check the connection and try again.',
  directMapping:
    'The conversation was created, but its direct-message label could not be saved. Use the existing room; do not create it again.'
}

const copies: Record<Locale, typeof en> = {
  en,
  vi: {
    unnamed: 'Người dùng Atum',
    members: 'Thành viên',
    invited: 'Đã mời',
    joined: 'Đã tham gia',
    remove: 'Xóa khỏi nhóm',
    confirmRemove: 'Xác nhận xóa',
    cancel: 'Hủy',
    leave: 'Rời cuộc trò chuyện',
    confirmLeave: 'Xác nhận rời',
    decline: 'Từ chối lời mời',
    confirmDecline: 'Xác nhận từ chối',
    accept: 'Chấp nhận lời mời',
    historyNotice: 'Rời hoặc bị xóa sẽ ngừng tham gia về sau. Không thể thu hồi tin nhắn đã nhận.',
    noMembership: 'Bạn không còn là thành viên. Vẫn có thể đọc tin nhắn đã nhận trước đó.',
    cannotSend: 'Quyền hiện tại trong phòng không cho phép gửi tin nhắn.',
    error: 'Chưa thực hiện được. Nội dung nhập vẫn được giữ; kiểm tra kết nối rồi thử lại.',
    directMapping:
      'Đã tạo cuộc trò chuyện nhưng chưa lưu được nhãn tin nhắn riêng. Hãy dùng phòng đã tạo, không tạo lại.'
  },
  ja: {
    unnamed: 'Atum ユーザー',
    members: 'メンバー',
    invited: '招待済み',
    joined: '参加済み',
    remove: '削除',
    confirmRemove: '削除を確定',
    cancel: 'キャンセル',
    leave: '会話から退出',
    confirmLeave: '退出を確定',
    decline: '招待を辞退',
    confirmDecline: '辞退を確定',
    accept: '招待を承認',
    historyNotice: '退出や削除で今後の参加は停止します。受信済みのメッセージは取り消せません。',
    noMembership: 'この会話のメンバーではありません。受信済みのメッセージは引き続き読めます。',
    cannotSend: '現在のルーム権限では送信できません。',
    error: '操作を完了できませんでした。入力は保持されています。接続を確認して再試行してください。',
    directMapping:
      '会話は作成されましたが、ダイレクトメッセージのラベルを保存できませんでした。再作成せず、既存のルームを使ってください。'
  },
  zh: {
    unnamed: 'Atum 用户',
    members: '成员',
    invited: '已邀请',
    joined: '已加入',
    remove: '移除',
    confirmRemove: '确认移除',
    cancel: '取消',
    leave: '离开对话',
    confirmLeave: '确认离开',
    decline: '拒绝邀请',
    confirmDecline: '确认拒绝',
    accept: '接受邀请',
    historyNotice: '离开或移除会停止今后的参与。已收到的消息无法收回。',
    noMembership: '您已不再是成员，仍可阅读以前收到的消息。',
    cannotSend: '当前房间权限不允许发送消息。',
    error: '无法完成操作。输入已保留，请检查连接后重试。',
    directMapping: '对话已创建，但私信标签未能保存。请使用现有房间，不要再次创建。'
  },
  'zh-hant': {
    unnamed: 'Atum 使用者',
    members: '成員',
    invited: '已邀請',
    joined: '已加入',
    remove: '移除',
    confirmRemove: '確認移除',
    cancel: '取消',
    leave: '離開對話',
    confirmLeave: '確認離開',
    decline: '拒絕邀請',
    confirmDecline: '確認拒絕',
    accept: '接受邀請',
    historyNotice: '離開或移除會停止今後的參與。已收到的訊息無法收回。',
    noMembership: '您已不再是成員，仍可閱讀以前收到的訊息。',
    cannotSend: '目前房間權限不允許傳送訊息。',
    error: '無法完成操作。輸入已保留，請檢查連線後重試。',
    directMapping: '對話已建立，但私訊標籤未能儲存。請使用現有房間，不要再次建立。'
  }
}

export function useConversationCopy() {
  return copies[useI18n().locale]
}
