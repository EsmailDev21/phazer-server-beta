import { looksExecutable, refuseAsset, sha256Hex, templateAssetKey, installAttachmentPrefix, reservationTarget } from './asset.policy';

const MAX = 1000;
const ok = (over: Partial<{ fileName: string; mimeType: string; bytes: Buffer }> = {}) =>
  refuseAsset({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 hello'), ...over }, MAX);

describe('asset policy', () => {
  it('allows an ordinary file', () => expect(ok()).toBeNull());

  it.each([
    ['PE/DOS (MZ)', Buffer.from('MZ\x90\x00')],
    ['ELF', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])],
    ['shebang script', Buffer.from('#!/usr/bin/env python\n')],
    ['Mach-O 64', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0])],
    ['Mach-O fat / java class', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0])],
  ])('refuses %s by its bytes whatever the name and type say', (_n, bytes) => {
    expect(looksExecutable(bytes)).toBe(true);
    expect(ok({ bytes, fileName: 'holiday.png', mimeType: 'image/png' })).toBe('BLOCKED_CONTENT');
  });

  it('does not mistake ordinary content for an executable', () => {
    for (const b of ['M', 'MY NOTES', '#hash tag', '', '%PDF']) expect(looksExecutable(Buffer.from(b))).toBe(false);
  });

  it('refuses by declared type and by extension (case-insensitive)', () => {
    expect(ok({ mimeType: 'application/x-msdownload' })).toBe('BLOCKED_TYPE');
    expect(ok({ mimeType: 'APPLICATION/X-SH' })).toBe('BLOCKED_TYPE');
    for (const n of ['a.exe', 'A.EXE', 'run.sh', 'x.jar', 'y.ps1', 'z.dmg', 'w.apk']) expect(ok({ fileName: n })).toBe('BLOCKED_TYPE');
  });

  it('refuses bad names, bad types, empty and oversized files', () => {
    for (const n of ['', '../a.pdf', 'dir/a.pdf', 'dir\\a.pdf', 'a\u0000.pdf', 'a\n.pdf']) expect(ok({ fileName: n })).toBe('BAD_NAME');
    for (const m of ['', 'pdf', 'application', '/pdf', 'a b/c']) expect(ok({ mimeType: m })).toBe('BAD_MIME');
    expect(ok({ bytes: Buffer.alloc(0) })).toBe('EMPTY');
    expect(ok({ bytes: Buffer.alloc(MAX + 1, 65) })).toBe('TOO_LARGE');
    expect(ok({ bytes: Buffer.alloc(MAX, 65) })).toBeNull();
  });

  it('hashes and keys are deterministic and scoped', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(templateAssetKey('T', 'h')).toBe('template-assets/T/h');
    expect(installAttachmentPrefix('A', 'I')).toBe('attachments/A/TEMPLATE_INSTALL/I/');
    expect(reservationTarget('I')).toBe('tpl-reserve:I');
  });
});
