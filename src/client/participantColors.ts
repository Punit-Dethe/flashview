/**
 * A participant owns a color for the lifetime of a classroom, not for each file.
 * Preserve distinct file/avatar matching without pink swatches.
 * There are 30 distinct swatches: one for each allowed student per room.
 */
export const PARTICIPANT_SWATCHES = [
  '#b45309', '#2f7de1', '#e5741a', '#8a5cf0', '#17956a',
  '#bf5151', '#178994', '#a13326', '#839330', '#417abb',
  '#a76b35', '#526d32', '#298c72', '#7564d2', '#c38a34',
  '#467fb2', '#4b538f', '#478d5a', '#9461b2', '#b26651',
  '#718c31', '#346ca9', '#006b5f', '#9f723a', '#368e9a',
  '#6b5d24', '#6076cf', '#548e43', '#a25ecb', '#34948a',
] as const;

/** Use the more legible foreground for each solid participant swatch. */
export function participantForeground(color: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return '#ffffff';
  const channels = [1,3,5].map(index => Number.parseInt(color.slice(index,index+2),16)/255)
    .map(channel => channel <= .04045 ? channel/12.92 : ((channel+.055)/1.055)**2.4);
  const luminance = channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
  return luminance > .179 ? '#000000' : '#ffffff';
}

export function assignParticipantColors(
  current: Readonly<Record<string, string>>,
  ids: readonly string[],
): Record<string,string> {
  let result: Record<string,string> | undefined;
  for (const id of ids) {
    if (!id || Object.prototype.hasOwnProperty.call(current,id) ||
        (result && Object.prototype.hasOwnProperty.call(result,id))) continue;
    result ??= { ...current };
    const assigned = Object.keys(result).length;
    result[id] = PARTICIPANT_SWATCHES[assigned % PARTICIPANT_SWATCHES.length];
  }
  return result ?? current as Record<string,string>;
}

/** Exact tint mixing used by the supplied HTML's pixel gradient. */
export function tintParticipantColor(color: string, t: number): string {
  const value = Number.parseInt(color.slice(1),16);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  const target=t<0?0:255;
  const mix=Math.min(1,Math.max(0,Math.abs(t)));
  return '#'+[16,8,0].map(shift=>
    Math.round(((value>>shift)&255)*(1-mix)+target*mix)
      .toString(16).padStart(2,'0')).join('');
}
