import type { CSSProperties } from 'react';

/** A consistent, tasteful identity for every uploaded PDF. */
const swatches = [
  { ink: '#6557C8', soft: '#F0EEFF', line: '#DAD4FF' },
  { ink: '#C65C45', soft: '#FFF0EA', line: '#F7D3C7' },
  { ink: '#278078', soft: '#E9F7F4', line: '#C5EAE3' },
  { ink: '#A16C32', soft: '#FFF5E5', line: '#F2DFC0' },
  { ink: '#B05287', soft: '#FFF0F8', line: '#F2D6E6' },
  { ink: '#4774BC', soft: '#EDF3FF', line: '#D2E2FA' },
  { ink: '#598057', soft: '#EEF6EB', line: '#D3E8CC' },
  { ink: '#8A66A9', soft: '#F5EFFB', line: '#E3D5F2' },
] as const;

export function fileAccentStyle(fileId: string): CSSProperties {
  let hash = 0;
  for (let i = 0; i < fileId.length; i++)
    hash = (Math.imul(31, hash) + fileId.charCodeAt(i)) | 0;
  const choice = swatches[(hash >>> 0) % swatches.length];
  return {
    '--file-accent': choice.ink,
    '--file-soft': choice.soft,
    '--file-line': choice.line,
  } as CSSProperties;
}
