import yazl from 'yazl';
import sharp from 'sharp';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Archive, LIMITS } from '../src/core/archive';

const relNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const imageRel = (id: string, file: string) =>
  `<Relationship Id="${id}" Type="${officeNS}/image" Target="media/${file}"/>`;
export function drawing(id: string, floating = false, index = 1) {
  const picture = `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="Example"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:srcRect l="1000" r="2000"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm rot="600000"><a:off x="0" y="0"/><a:ext cx="2743200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
  const size = `<wp:extent cx="2743200" cy="1828800"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`;
  return `<w:r><w:drawing>${
    floating
      ? `<wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>320000</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>160000</wp:posOffset></wp:positionV>${size}<wp:wrapSquare wrapText="bothSides"/><wp:docPr id="${index}" name="Floating"/><wp:cNvGraphicFramePr/>${picture}</wp:anchor>`
      : `<wp:inline distT="0" distB="0" distL="0" distR="0">${size}<wp:docPr id="${index}" name="Inline"/><wp:cNvGraphicFramePr/>${picture}</wp:inline>`
  }</w:drawing></w:r>`;
}
const namespaces = `xmlns:w="${w}" xmlns:r="${officeNS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`;
export function parts(images: Record<string, Buffer> = {}): Map<string, Buffer> {
  const names = Object.keys(images);
  const pictureBody = names
    .map((_, i) => `<w:p>${drawing(`rId${i + 1}`, i === 1, i + 1)}</w:p>`)
    .join('');
  const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`;
  const rootRels = `<Relationships xmlns="${relNS}"><Relationship Id="rId1" Type="${officeNS}/officeDocument" Target="word/document.xml"/></Relationships>`;
  const mainRels = `<Relationships xmlns="${relNS}">${names.map((file, i) => imageRel(`rId${i + 1}`, file)).join('')}<Relationship Id="rHeader" Type="${officeNS}/header" Target="header1.xml"/><Relationship Id="rFooter" Type="${officeNS}/footer" Target="footer1.xml"/><Relationship Id="rExternal" Type="${officeNS}/image" Target="https://example.invalid/picture.jpg" TargetMode="External"/></Relationships>`;
  const repeated = names.length ? drawing('rId1', false, 100) : '<w:r><w:t>Sample text</w:t></w:r>';
  const body = `<w:document ${namespaces}><w:body><w:p><w:r><w:t>DocZip layout verification</w:t></w:r></w:p>${pictureBody}<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="5000" w:type="dxa"/></w:tcPr><w:p>${repeated}</w:p></w:tc></w:tr></w:tbl><w:p/><w:sectPr><w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="default" r:id="rFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const result = new Map<string, Buffer>([
    ['[Content_Types].xml', Buffer.from(contentTypes)],
    ['_rels/.rels', Buffer.from(rootRels)],
    ['word/document.xml', Buffer.from(body)],
    ['word/_rels/document.xml.rels', Buffer.from(mainRels)],
    ['word/header1.xml', Buffer.from(`<w:hdr ${namespaces}><w:p>${repeated}</w:p></w:hdr>`)],
    ['word/footer1.xml', Buffer.from(`<w:ftr ${namespaces}><w:p>${repeated}</w:p></w:ftr>`)],
    ['word/embeddings/object1.bin', Buffer.from('This embedded attachment must remain untouched.')],
  ]);
  for (const part of ['header1.xml', 'footer1.xml'])
    result.set(
      `word/_rels/${part}.rels`,
      Buffer.from(
        `<Relationships xmlns="${relNS}">${names.length ? imageRel('rId1', names[0]) : ''}</Relationships>`,
      ),
    );
  for (const [name, data] of Object.entries(images)) result.set(`word/media/${name}`, data);
  return result;
}
export async function writeZip(file: string, entries: Map<string, Buffer>, compress = false) {
  const zip = new yazl.ZipFile();
  const done = pipeline(zip.outputStream, createWriteStream(file));
  for (const [name, data] of entries) zip.addBuffer(data, name, { compress });
  zip.end();
  await done;
}
export async function readZip(file: string) {
  const a = await Archive.open(file);
  const result = new Map<string, Buffer>();
  try {
    for (const e of a.entries)
      if (!e.fileName.endsWith('/')) result.set(e.fileName, await a.read(e, LIMITS.entryBytes));
  } finally {
    a.close();
  }
  return result;
}
export async function photo(width = 3600, height = 2400) {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 42;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    pixels[i] = ((i / 3 / width) * 0.4 + (i % (width * 3)) * 0.06 + (seed % 35)) % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 98 })
    .withMetadata({ density: 144, orientation: 6 })
    .toBuffer();
}
export async function transparentPng() {
  return sharp(
    Buffer.from(
      `<svg width="2800" height="1800"><rect x="100" y="100" width="2200" height="1400" rx="100" fill="#167b5c" fill-opacity=".45"/><text x="180" y="800" font-size="200" fill="#163f2a">DocZip alpha</text></svg>`,
    ),
  )
    .png({ compressionLevel: 0 })
    .toBuffer();
}
