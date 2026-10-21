import { describe, test, expect } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { detectArchiveKind, listArchiveMembers, readArchiveMember } from '../../src/mcp/archive-members';

function zipOf(files: Array<[string, string, boolean]>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const [name, text, deflate] of files) {
    const raw = Buffer.from(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, nameBuf, data);
    central.push(ch, nameBuf);
    off += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('archive members', () => {
  // INVARIANT: zip artifacts list members and read one without extracting to disk.
  // Callers (the builder) have no way to decode an archive otherwise.
  test('zip: stored and deflated members list and read back', () => {
    const zip = zipOf([['a.txt', 'alpha', false], ['dir/b.txt', 'bravo bravo', true]]);
    expect(detectArchiveKind('x.zip', zip)).toBe('zip');
    expect(listArchiveMembers('zip', zip)).toEqual([
      { name: 'a.txt', size: 5 },
      { name: 'dir/b.txt', size: 11 },
    ]);
    expect(readArchiveMember('zip', zip, 'dir/b.txt')!.toString()).toBe('bravo bravo');
    expect(readArchiveMember('zip', zip, 'missing')).toBeNull();
  });
});

function tarHeader(name: string, sizeField: string, magic = 'ustar\0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write(sizeField, 124);
  h.write('0', 156);
  h.write(magic, 257);
  return h;
}

describe('tar parsing robustness', () => {
  // INVARIANT: a hostile tar header never hangs the MCP server — artifacts are untrusted data.
  test('negative or out-of-range sizes are rejected, not looped on', () => {
    expect(() => listArchiveMembers('tar', Buffer.concat([tarHeader('a', '-1000\0'), Buffer.alloc(1024)]))).toThrow(/corrupt tar/);
    expect(() => listArchiveMembers('tar', Buffer.concat([tarHeader('a', '77777777\0'), Buffer.alloc(1024)]))).toThrow(/corrupt tar/);
  });

  test('a plain tar lists members', () => {
    const data = Buffer.alloc(512);
    data.write('hi');
    const tar = Buffer.concat([tarHeader('f.txt', '00000000002\0'), data, Buffer.alloc(1024)]);
    expect(detectArchiveKind('x.tar', tar)).toBe('tar');
    expect(listArchiveMembers('tar', tar)).toEqual([{ name: 'f.txt', size: 2 }]);
    expect(readArchiveMember('tar', tar, 'f.txt')!.toString()).toBe('hi');
  });

  test('a short PK blob is a clean error, and a gzip bomb is capped', () => {
    expect(() => listArchiveMembers('zip', Buffer.from('PK\x03\x04'))).toThrow(/not a valid zip/);
    const bomb = require('node:zlib').gzipSync(Buffer.alloc(80 * 1024 * 1024));
    expect(() => listArchiveMembers('tgz', bomb)).toThrow();
  });
});
