import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

export async function createWebArchive(root, files, archive) {
  const manifest = [...new Set(files)];
  for (const relative of manifest) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
      throw new Error('Unsafe package path');
    const info = await lstat(path.join(root, relative));
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Package entry must be a regular file');
  }
  const zip = new yazl.ZipFile();
  const done = pipeline(zip.outputStream, createWriteStream(archive));
  // Only files explicitly copied by the packager enter the archive. Never walk
  // an existing release directory that may contain logs or user-added documents.
  for (const relative of manifest)
    zip.addFile(
      path.join(root, relative),
      path.posix.join(path.basename(root), relative.replaceAll('\\', '/')),
    );
  zip.end();
  await done;
}
