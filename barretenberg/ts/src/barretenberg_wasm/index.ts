import { getSharedMemoryAvailable, getAvailableThreads, supportsMemory64 } from './helpers/node/index.js';
import { fetchCode } from './fetch_code/index.js';

export async function fetchModuleAndThreads(
  desiredThreads = 32,
  wasmPath?: string,
  logger: (msg: string) => void = () => {},
  options: { memory64?: boolean } = {},
) {
  const shared = getSharedMemoryAvailable();

  const availableThreads = shared ? await getAvailableThreads(logger) : 1;
  // We limit the number of threads to 32 as we do not benefit from greater numbers.
  const limitedThreads = Math.min(desiredThreads, availableThreads, 32);

  const memory64Supported = supportsMemory64();
  const preferMemory64 = options.memory64 ?? true;
  let useMemory64 = preferMemory64 && memory64Supported;

  if (useMemory64) {
    logger('Memory64 supported; attempting to load wasm64 build.');
  }

  let code: Uint8Array<ArrayBuffer>;
  let module: WebAssembly.Module;
  try {
    logger(`Fetching bb wasm from ${wasmPath ?? 'default location'}`);
    code = await fetchCode(shared, wasmPath, { memory64: useMemory64 });
    logger(`Compiling bb wasm of ${code.byteLength} bytes`);
    module = await WebAssembly.compile(code);
    logger('Compilation of bb wasm complete');
  } catch (err: any) {
    if (!useMemory64) {
      throw err;
    }
    logger(`Failed to load wasm64 build (${err?.message ?? err}). Falling back to wasm32.`);
    useMemory64 = false;
    logger(`Fetching bb wasm from ${wasmPath ?? 'default location'}`);
    code = await fetchCode(shared, wasmPath, { memory64: false });
    logger(`Compiling bb wasm of ${code.byteLength} bytes`);
    module = await WebAssembly.compile(code);
    logger('Compilation of bb wasm complete');
  }

  return { module, threads: limitedThreads, memory64: useMemory64 };
}
