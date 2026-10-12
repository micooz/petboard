/**
 * 内容寻址：`SHA-256(载荷)` 的前 8 位十六进制大写（FAT 8.3 的主名正好 8 个字符）。
 *
 * `salt` 只给“同一张精灵图拆出来的不同行”用：两行像素完全相同时，
 * 不加盐会被内容寻址合并成同一个文件；加了行号后每段仍是独立素材。
 */
export async function contentId(payload: Uint8Array, salt = ''): Promise<string> {
  const data = salt === '' ? payload : withSalt(payload, salt);
  // DOM 的类型要求 `Uint8Array<ArrayBuffer>`（见 bytes.ts 的 Bytes 别名）；
  // 运行时 `BufferSource` 本来就接受 Uint8Array，这里只是让类型对上。
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 4; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.toUpperCase();
}

function withSalt(payload: Uint8Array, salt: string): Uint8Array {
  const seed = new TextEncoder().encode(salt);
  const data = new Uint8Array(payload.length + 1 + seed.length);
  data.set(payload, 0);
  data[payload.length] = 0;
  data.set(seed, payload.length + 1);
  return data;
}
