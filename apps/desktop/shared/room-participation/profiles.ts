import type { SessionProfile, SessionProfileFlags } from './types'

/** Profile suffix only; retain agent/device/owner/room/mode/audience in the full key. */
export function roomSessionProfile(flags: SessionProfileFlags): SessionProfile {
  return {
    key: `room:shared=${Number(flags.shared_room)}:reply=${Number(flags.reply_only)}:pet=${Number(flags.pet_surface)}`,
    tools: flags.reply_only ? 'none' : flags.shared_room ? 'shared_ceiling' : 'standard',
    memory: !flags.reply_only && !flags.shared_room,
    petTool: flags.pet_surface && !flags.shared_room && !flags.reply_only
  }
}
