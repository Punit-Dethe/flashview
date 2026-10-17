/**
 * Isolated real-device A/B experiment. Default: no phone-side thumbnail
 * rendering, JPEG relay, host thumbnail decoding or presenter thumbnail.
 * To restore the existing path, add ?thumbnails=1 to BOTH host and student
 * pages (use &thumbnails=1 when another query parameter already exists).
 * Original PDF transfer, caching and PDF.js rendering are unchanged.
 */
export const THUMBNAILS_ENABLED = typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('thumbnails') === '1';
