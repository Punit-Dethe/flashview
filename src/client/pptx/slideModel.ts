import { ZipReader, Uint8ArrayReader, TextWriter, BlobWriter } from '@zip.js/zip.js';

type ZipEntry = Awaited<ReturnType<ZipReader<Uint8Array>['getEntries']>>[number];
export type PptxSlideItem = {
  id: string;
  kind: 'text' | 'shape' | 'image';
  x: number; y: number; width: number; height: number;
  text?: string; size?: number; color?: string; fill?: string;
  radius?: string; src?: string;
  stroke?: string; strokeWidth?: number;
};
export type PptxSlide = {
  path: string;
  width: number;
  height: number;
  background: string;
  items: PptxSlideItem[];
};
const MAX_XML = 3 * 1024 * 1024;
const MAX_IMAGE = 16 * 1024 * 1024;
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function parseXml(value: string): XMLDocument {
  const doc = new DOMParser().parseFromString(value, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length)
    throw new Error('Invalid PowerPoint XML');
  return doc;
}
function descendants(root: Document | Element, name: string): Element[] {
  return [...root.getElementsByTagName('*')].filter(el => el.localName === name);
}
function one(root: Document | Element, name: string): Element | undefined {
  return descendants(root, name)[0];
}
function direct(root: Element | undefined, name: string): Element | undefined {
  return [...(root?.children ?? [])].find(el => el.localName === name);
}
function num(value: string | number | null | undefined, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : fallback;
}
/** OOXML a:alpha uses 0..100000; 0 means completely transparent.
 * Only inspect the actual fill element. Descendant searches through spPr
 * can accidentally pick up an outline color and paint a text box solid.
 */
function color(root: Document | Element | undefined, fallback: string): string {
  if (!root) return fallback;
  const node = root instanceof Element && root.localName === 'srgbClr'
    ? root : direct(root as Element, 'srgbClr');
  const value = node?.getAttribute('val');
  if (!value || !/^[0-9a-f]{6}$/i.test(value)) return fallback;
  const alpha = direct(node, 'alpha');
  const opacity = alpha ? Math.max(0, Math.min(1, num(alpha.getAttribute('val'), 100000) / 100000)) : 1;
  if (opacity === 0) return 'transparent';
  if (opacity === 1) return '#' + value;
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return 'rgba(' + red + ', ' + green + ', ' + blue + ', ' + opacity + ')';
}

function shapePaint(spPr: Element | undefined): { fill: string; stroke?: string; strokeWidth?: number } {
  if (!spPr) return { fill: 'transparent' };
  const fill = direct(spPr, 'noFill') ? 'transparent' : color(direct(spPr, 'solidFill'), 'transparent');
  const ln = direct(spPr, 'ln');
  if (!ln || direct(ln, 'noFill')) return { fill };
  const stroke = color(direct(ln, 'solidFill'), 'transparent');
  if (stroke === 'transparent') return { fill };
  // PowerPoint line widths are in EMU. Convert to CSS pixels at 96 DPI.
  const strokeWidth = Math.max(0.5, Math.min(18, num(ln.getAttribute('w'), 12700) * 96 / 914400));
  return { fill, stroke, strokeWidth };
}
function relsPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return path.slice(0, slash + 1) + '_rels/' + path.slice(slash + 1) + '.rels';
}
function resolve(path: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segments = (path.slice(0, path.lastIndexOf('/') + 1) + target).split('/');
  const output: string[] = [];
  for (const segment of segments) {
    if (segment === '..') output.pop();
    else if (segment && segment !== '.') output.push(segment);
  }
  return output.join('/');
}

export class CompletedPptxArchive {
  private readonly zip: ZipReader<Uint8Array>;
  private entries = new Map<string, ZipEntry>();
  private slides: string[] = [];
  private dimensions = { width: 9144000, height: 5143500 };
  private ownedUrls = new Set<string>();
  /** Entire verified file is already in local memory. zip.js has no incomplete
   stream, network or cache dependency in this fidelity baseline. */
  constructor(bytes: Uint8Array) { this.zip = new ZipReader(new Uint8ArrayReader(bytes)); }
  getSlidePaths(): string[] { return this.slides; }
  private async text(path: string): Promise<string> {
    const entry = this.entries.get(path);
    if (!entry || !('getData' in entry)) throw new Error('Missing PowerPoint resource: ' + path);
    if (num(entry.uncompressedSize, MAX_XML + 1) > MAX_XML)
      throw new Error('PowerPoint XML is too large to preview safely');
    return await entry.getData(new TextWriter());
  }
  private async relationships(path: string): Promise<Map<string, string>> {
    const rels = new Map<string, string>();
    const relPath = relsPath(path);
    if (!this.entries.has(relPath)) return rels;
    const doc = parseXml(await this.text(relPath));
    for (const relationship of descendants(doc, 'Relationship')) {
      if (relationship.getAttribute('TargetMode') === 'External') continue;
      const id = relationship.getAttribute('Id');
      const target = relationship.getAttribute('Target');
      if (id && target) rels.set(id, resolve(path, target));
    }
    return rels;
  }
  async index(): Promise<string[]> {
    const entries = await this.zip.getEntries();
    if (entries.length > 30_000) throw new Error('This presentation contains too many ZIP entries');
    this.entries = new Map(entries.map(entry => [entry.filename, entry]));
    if (!this.entries.has('[Content_Types].xml'))
      throw new Error('Invalid PowerPoint archive');
    const candidates = [...this.entries.keys()]
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/\d+(?=\.xml$)/)?.[0]) - Number(b.match(/\d+(?=\.xml$)/)?.[0]));
    if (!candidates.length) throw new Error('No PowerPoint slides were found');
    const pptPath = 'ppt/presentation.xml';
    if (this.entries.has(pptPath)) {
      try {
        const xml = parseXml(await this.text(pptPath));
        const sz = one(xml, 'sldSz');
        if (sz) {
          this.dimensions = {
            width: Math.max(1, num(sz.getAttribute('cx'), this.dimensions.width)),
            height: Math.max(1, num(sz.getAttribute('cy'), this.dimensions.height)),
          };
        }
        const relations = await this.relationships(pptPath);
        const ordered = descendants(xml, 'sldId')
          .map(el => relations.get(el.getAttributeNS(OFFICE_REL, 'id') || el.getAttribute('r:id') || ''))
          .filter((path): path is string => !!path && this.entries.has(path));
        if (ordered.length) this.slides = ordered;
      } catch {
        // Even malformed slide order metadata should not hide otherwise
        // readable individual slides in this experimental viewer.
      }
    }
    if (!this.slides.length) this.slides = candidates;
    return this.slides;
  }
  async slide(path: string, onEarly: (slide: PptxSlide) => void): Promise<PptxSlide> {
    if (!this.slides.includes(path)) throw new Error('Unknown slide');
    const xml = parseXml(await this.text(path));
    const root = one(xml, 'spTree');
    if (!root) throw new Error('This slide has no drawing tree');
    const bgPr = one(xml, 'bgPr');
    const background = bgPr ? color(direct(bgPr, 'solidFill'), '#ffffff') : '#ffffff';
    const model: PptxSlide = {
      path, ...this.dimensions, background, items: [],
    };
    const imageIds: { item: PptxSlideItem; id: string }[] = [];
    let position = 0;
    for (const child of [...root.children]) {
      if (!['sp', 'pic'].includes(child.localName)) continue;
      const xfrm = one(child, 'xfrm');
      const off = xfrm && direct(xfrm, 'off');
      const ext = xfrm && direct(xfrm, 'ext');
      if (!off || !ext) continue; // Masters and unsupported inherited geometry.
      const item: PptxSlideItem = {
        id: String(position++),
        kind: child.localName === 'pic' ? 'image' : 'shape',
        x: num(off.getAttribute('x')),
        y: num(off.getAttribute('y')),
        width: num(ext.getAttribute('cx')),
        height: num(ext.getAttribute('cy')),
      };
      if (item.width <= 0 || item.height <= 0) continue;
      if (item.kind === 'image') {
        const blip = one(child, 'blip');
        const id = blip?.getAttributeNS(OFFICE_REL, 'embed') || blip?.getAttribute('r:embed');
        if (id) imageIds.push({ item, id });
      } else {
        const body = one(child, 'txBody');
        const paragraphs = body ? descendants(body, 'p') : [];
        const content = paragraphs.map(p => descendants(p, 't').map(t => t.textContent || '').join('')).join('\n');
        item.text = content;
        item.kind = content ? 'text' : 'shape';
        Object.assign(item, shapePaint(direct(child, 'spPr')));
        const geom = one(child, 'prstGeom')?.getAttribute('prst');
        item.radius = geom === 'ellipse' ? '50%' : '0';
        const style = body && (one(body, 'rPr') || one(body, 'defRPr') || one(body, 'endParaRPr'));
        item.size = num(style?.getAttribute('sz'), 2000) / 100 * 1.3333;
        item.color = color(direct(style, 'solidFill'), '#1d2636');
      }
      model.items.push(item);
    }
    // A slide's text/shapes become available without waiting for its images.
    onEarly({ ...model, items: model.items.map(item => ({ ...item })) });
    if (!imageIds.length) return model;
    const rels = await this.relationships(path);
    await Promise.all(imageIds.map(async ({ item, id }) => {
      const media = rels.get(id);
      if (!media || !/\.(png|jpe?g|gif|webp)$/i.test(media)) return;
      const entry = this.entries.get(media);
      if (!entry || !('getData' in entry) || num(entry.uncompressedSize, MAX_IMAGE + 1) > MAX_IMAGE) return;
      const mime = /\.png$/i.test(media) ? 'image/png' : /\.gif$/i.test(media)
        ? 'image/gif' : /\.webp$/i.test(media) ? 'image/webp' : 'image/jpeg';
      const blob = await entry.getData(new BlobWriter(mime));
      const url = URL.createObjectURL(blob);
      this.ownedUrls.add(url);
      item.src = url;
    }));
    return { ...model, items: model.items.map(item => ({ ...item })) };
  }
  async close(): Promise<void> {
    for (const url of this.ownedUrls) URL.revokeObjectURL(url);
    this.ownedUrls.clear();
    await this.zip.close();
  }
}
