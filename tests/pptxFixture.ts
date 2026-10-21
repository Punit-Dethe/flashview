import { ZipWriter, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js';

/** Minimal genuine OOXML slideshow. No network fixture or third-party Office converter. */
export async function makePowerPointFixture(slideCount = 1): Promise<Buffer> {
  const ct='application/vnd.openxmlformats-officedocument.presentationml.';
  const relns='http://schemas.openxmlformats.org/package/2006/relationships';
  const presns='http://schemas.openxmlformats.org/presentationml/2006/main';
  const drawns='http://schemas.openxmlformats.org/drawingml/2006/main';
  const rns='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const partTypes='http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const parts: Record<string,string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="${ct}presentation.main+xml"/>
${Array.from({length:slideCount}, (_,i) => `<Override PartName="/ppt/slides/slide${i+1}.xml" ContentType="${ct}slide+xml"/>`).join('')}
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${ct}slideLayout+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${ct}slideMaster+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`,
    '_rels/.rels': `<Relationships xmlns="${relns}"><Relationship Id="rId1" Type="${partTypes}officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="${presns}" xmlns:r="${rns}">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${Array.from({length:slideCount}, (_,i) => `<p:sldId id="${256+i}" r:id="rId${i+2}"/>`).join('')}</p:sldIdLst>
<p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
<p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${relns}">
<Relationship Id="rId1" Type="${partTypes}slideMaster" Target="slideMasters/slideMaster1.xml"/>
${Array.from({length:slideCount}, (_,i) => `<Relationship Id="rId${i+2}" Type="${partTypes}slide" Target="slides/slide${i+1}.xml"/>`).join('')}
</Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="${presns}" xmlns:a="${drawns}" xmlns:r="${rns}">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7000000" cy="900000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="4000"/>
<a:t>FlashView PowerPoint Test</a:t></a:r></a:p></p:txBody>
</p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${relns}"><Relationship Id="rId1" Type="${partTypes}slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout xmlns:p="${presns}" xmlns:a="${drawns}" type="blank" preserve="1">
<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `<Relationships xmlns="${relns}"><Relationship Id="rId1" Type="${partTypes}slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster xmlns:p="${presns}" xmlns:a="${drawns}" xmlns:r="${rns}">
<p:cSld name="Master"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6"
hlink="hlink" folHlink="folHlink" bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': `<Relationships xmlns="${relns}">
<Relationship Id="rId1" Type="${partTypes}slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="${partTypes}theme" Target="../theme/theme1.xml"/></Relationships>`,
    'ppt/theme/theme1.xml': `<a:theme xmlns:a="${drawns}" name="FlashView"><a:themeElements>
<a:clrScheme name="FlashView"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
<a:accent1><a:srgbClr val="3366CC"/></a:accent1><a:accent2><a:srgbClr val="CC6633"/></a:accent2>
<a:accent3><a:srgbClr val="669933"/></a:accent3><a:accent4><a:srgbClr val="9966CC"/></a:accent4>
<a:accent5><a:srgbClr val="CC6699"/></a:accent5><a:accent6><a:srgbClr val="33CCCC"/></a:accent6>
<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme>
<a:fontScheme name="FlashView"><a:majorFont><a:latin typeface="Arial"/></a:majorFont>
<a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme>
<a:fmtScheme name="FlashView"><a:fillStyleLst><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme></a:themeElements></a:theme>`,
  };
  for (let i = 2; i <= slideCount; i++) {
    parts[`ppt/slides/slide${i}.xml`] = parts['ppt/slides/slide1.xml'].replace('PowerPoint Test', 'PowerPoint Test ' + i);
    parts[`ppt/slides/_rels/slide${i}.xml.rels`] = parts['ppt/slides/_rels/slide1.xml.rels'];
  }
  const archive = new ZipWriter(new Uint8ArrayWriter());
  for(const [name,xml] of Object.entries(parts)) await archive.add(name,new TextReader(xml));
  const bytes=await archive.close();
  return Buffer.from(bytes);
}
