/**
 * File-type display is cosmetic. Never interpret or execute untrusted bytes.
 * The transfer protocol transports the original bytes unchanged.
 */
export function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** Browser PowerPoint engine supports OOXML PPTX and slideshow PPSX files.
 * Legacy .ppt files are still download-only. */
export function isPowerPointName(name: string): boolean {
  return /\.(pptx|ppsx)$/i.test(name);
}

export function fileTypeLabel(name: string): string {
  const extension = name.split('.').pop()?.toUpperCase() ?? '';
  if (!extension || extension === name.toUpperCase()) return 'FILE';
  if (/^[A-Z0-9]{1,5}$/.test(extension)) return extension;
  return 'FILE';
}

/** Safe filename for the user-initiated browser download attribute. */
export function safeDownloadName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().slice(0, 130);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'flashview-file';
}
