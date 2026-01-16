import pako from 'pako';

// Annoyingly the wasm declares if it's memory is shared or not. So now we need two wasms if we want to be
// able to fallback on "non shared memory" situations.
export async function fetchCode(
  multithreaded: boolean,
  wasmPath?: string,
  options: { memory64?: boolean } = {},
) {
  const memory64 = options.memory64 ?? false;
  let url: string;
  if (wasmPath) {
    const suffix = `${multithreaded ? '-threads' : ''}${memory64 ? '-memory64' : ''}`;
    const filePath = wasmPath.split('/').slice(0, -1).join('/');
    const fileNameWithExtensions = wasmPath.split('/').pop();
    const [fileName, ...extensions] = fileNameWithExtensions!.split('.');
    url = `${filePath}/${fileName}${suffix}.${extensions.join('.')}`;
  } else {
    if (memory64) {
      url = multithreaded
        ? (await import('./barretenberg-threads-memory64.js')).default
        : (await import('./barretenberg-memory64.js')).default;
    } else {
      url = multithreaded
        ? (await import('./barretenberg-threads.js')).default
        : (await import('./barretenberg.js')).default;
    }
  }
  const res = await fetch(url);
  // Default bb wasm is compressed, but user could point it to a non-compressed version
  const maybeCompressedData = await res.arrayBuffer();
  const buffer = new Uint8Array(maybeCompressedData);
  const isGzip =
    // Check magic number
    buffer[0] === 0x1f &&
    buffer[1] === 0x8b &&
    // Check compression method:
    buffer[2] === 0x08;
  if (isGzip) {
    const decompressedData = pako.ungzip(buffer);
    return decompressedData.buffer as unknown as Uint8Array<ArrayBuffer>;
  } else {
    return buffer;
  }
}
