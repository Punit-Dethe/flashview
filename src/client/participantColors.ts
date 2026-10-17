/**
 * A participant owns a color for the lifetime of a classroom, not for each file.
 * The first five hues exactly match the reference HTML's sample people.
 * There are 30 distinct swatches: one for each allowed student per room.
 */
export const PARTICIPANT_SWATCHES = [
  '#ec4e8a', '#2f7de1', '#e5741a', '#8a5cf0', '#17956a',
  '#bf5151', '#178994', '#c14f9d', '#839330', '#417abb',
  '#a76b35', '#e26079', '#298c72', '#7564d2', '#c38a34',
  '#467fb2', '#ac477c', '#478d5a', '#9461b2', '#b26651',
  '#718c31', '#346ca9', '#c35aab', '#9f723a', '#368e9a',
  '#d15162', '#6076cf', '#548e43', '#a25ecb', '#34948a',
] as const;

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
