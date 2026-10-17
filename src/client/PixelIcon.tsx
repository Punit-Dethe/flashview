import { useId } from 'react';

/** Pixel shapes and gradients transcribed from the supplied FlashView v8 HTML. */
type PixelKind = 'folder' | 'doc' | 'pdf' | 'ppt' | 'img' | 'vid' | 'gen';
const base = {
  doc: ['########....','#########...','##########..','###########.','############','############','##wwwwwwww##','############','##wwwwww####','############','##wwwwwwww##','############','############','############'],
  folder: ['#####.........','##############','##############','######ww######','######ww######','####wwwwww####','#####wwww#####','######ww######','##############','##############'],
};
const FONT: Record<string,string[]> = {
  P:['###','#.#','###','#..','#..'], D:['##.','#.#','#.#','#.#','##.'],
  F:['###','#..','##.','#..','#..'], T:['###','.#.','.#.','.#.','.#.'],
};
function labelRows(word: 'PDF' | 'PPT'): string[] {
  return [0,1,2,3,4].map(y=>[...word].map(c=>FONT[c][y]).join('.'));
}
function documentPixels(glyph: string[]): string[] {
  const grid=Array.from({length:16},(_,y)=>Array.from({length:13},(_,x)=>
    y<4&&x>=9 ? ((x-9)>y ? '.' : 'o') : '#'));
  glyph.forEach((line,y)=>[...line].forEach((c,x)=>{if(c==='#'&&grid[8+y]?.[1+x]) grid[8+y][1+x]='w';}));
  return grid.map(row=>row.join(''));
}
const pixels: Record<PixelKind,string[]> = {
  ...base,
  pdf: documentPixels(labelRows('PDF')),
  ppt: documentPixels(labelRows('PPT')),
  gen: documentPixels(['###########','...........','#######....','...........','###########']),
  img: ['#############','#############','########ww###','########ww###','#############','####w########','###www####w##','##wwwww##www#','#wwwwwwwwwww#','#############','#############'],
  vid: ['#############','#############','#####w#######','#####ww######','#####www#####','#####wwww####','#####www#####','#####ww######','#####w#######','#############','#############'],
};
export function pixelKindForName(name: string): PixelKind {
  const ext=name.split('.').pop()?.toLowerCase() ?? '';
  if(ext==='pdf')return 'pdf';
  if(/^(pptx?|key)$/.test(ext))return 'ppt';
  if(/^(jpe?g|png|gif|webp|heic|svg)$/.test(ext))return 'img';
  if(/^(mp4|mov|mkv|webm|avi)$/.test(ext))return 'vid';
  return 'gen';
}

export function PixelIcon({kind,className}: {kind:PixelKind;className?:string}) {
  const id=useId().replace(/:/g,'');
  const map=pixels[kind], width=map[0].length;
  return <svg className={className} aria-hidden="true"
    viewBox={`0 0 ${width} ${map.length}`} shapeRendering="crispEdges" focusable="false">
    <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#4a5062"/><stop offset="1" stopColor="#0e0f14"/>
    </linearGradient></defs>
    {map.flatMap((row,y)=>[...row].map((cell,x)=>cell==='.'?null:
      <rect key={y+'-'+x} x={x} y={y} width="1.04" height="1.04"
        fill={cell==='w'?'#fff':cell==='o'?'#9097a8':`url(#${id})`}
        opacity={cell==='#'&&(x+y)%5===0?0.9:1}/>))}
  </svg>;
}
