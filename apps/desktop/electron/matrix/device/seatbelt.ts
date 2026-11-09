/** Public device-host facade. Policy composition lives beside the pinned srt adapter. */
export {
  generateSeatbeltProfile,
  makeBestEffortResolver,
  relaxesProfile,
  type SeatbeltProfileOptions,
  type SeatbeltRuntime
} from './guard/profile'
