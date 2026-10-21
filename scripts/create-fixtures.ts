import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parts, photo, transparentPng, writeZip } from '../tests/fixtures';
const dir = path.resolve('test-results', 'desktop', 'input');
async function main() {
await mkdir(dir, { recursive: true });
const jpg = await photo();
const png = await transparentPng();
await writeZip(path.join(dir, '项目报告 含图片.docx'), parts({ 'photo.jpg': jpg, 'alpha.png': png }));
await writeZip(path.join(dir, '会议纪要.docx'), parts());
await writeFile(path.join(dir, '损坏文档.docx'), 'invalid DOCX');
console.log(dir);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
