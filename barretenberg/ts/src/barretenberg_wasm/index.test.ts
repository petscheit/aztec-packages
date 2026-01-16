import { createMainWorker } from '../barretenberg_wasm/barretenberg_wasm_main/factory/node/index.js';
import { BarretenbergWasmMainWorker } from '../barretenberg_wasm/barretenberg_wasm_main/index.js';
import { getRemoteBarretenbergWasm } from '../barretenberg_wasm/helpers/index.js';
import { fetchModuleAndThreads } from '../barretenberg_wasm/index.js';
import { Worker } from 'worker_threads';

describe('barretenberg wasm', () => {
  let wasm: BarretenbergWasmMainWorker;
  let worker: Worker;

  beforeAll(async () => {
    worker = await createMainWorker();
    wasm = getRemoteBarretenbergWasm<BarretenbergWasmMainWorker>(worker);
    const { module, threads, memory64 } = await fetchModuleAndThreads(2);
    await wasm.init(module, threads, undefined, undefined, undefined, memory64);
  }, 20000);

  afterAll(async () => {
    await wasm.destroy();
    await worker.terminate();
  });

  it('should new malloc, transfer and slice mem', async () => {
    const length = 1024;
    const ptr = await wasm.malloc(length);
    const end = typeof ptr === 'bigint' ? ptr + BigInt(length) : ptr + length;
    const buf = Buffer.alloc(length, 128);
    await wasm.writeMemory(ptr, Uint8Array.from(buf));
    const result = Buffer.from(await wasm.getMemorySlice(ptr, end));
    await wasm.free(ptr);
    expect(result).toStrictEqual(buf);
  });

  it('test abort', async () => {
    await expect(() => wasm.call('test_abort')).rejects.toThrow();
  });

  it('should new malloc, transfer and slice mem', async () => {
    const length = 1024;
    const ptr = await wasm.malloc(length);
    const end = typeof ptr === 'bigint' ? ptr + BigInt(length) : ptr + length;
    const buf = Buffer.alloc(length, 128);
    await wasm.writeMemory(ptr, Uint8Array.from(buf));
    const result = Buffer.from(await wasm.getMemorySlice(ptr, end));
    await wasm.free(ptr);
    expect(result).toStrictEqual(buf);
  });
});
