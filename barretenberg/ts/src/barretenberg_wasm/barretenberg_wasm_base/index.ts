import { randomBytes } from '../../random/index.js';

export type WasmPtr = number | bigint;

/**
 * Base implementation of BarretenbergWasm.
 * Contains code that is common to the "main thread" implementation and the "child thread" implementation.
 */
export class BarretenbergWasmBase {
  protected memStore: { [key: string]: Uint8Array } = {};
  protected memory!: WebAssembly.Memory;
  protected instance!: WebAssembly.Instance;
  protected logger: (msg: string) => void = () => {};
  protected memory64 = false;
  protected pointerSize = 4;

  protected getImportObj(memory: WebAssembly.Memory) {
    /* eslint-disable camelcase */
    const importObj = {
      // We need to implement a part of the wasi api:
      // https://github.com/WebAssembly/WASI/blob/main/phases/snapshot/docs.md
      // We literally only need to support random_get, everything else is noop implementated in barretenberg.wasm.
      wasi_snapshot_preview1: {
        random_get: (out: WasmPtr, length: number | bigint) => {
          const outPtr = this.toJsNumber(out, 'random_get');
          const outLength = this.toJsNumber(length as WasmPtr, 'random_get:length');
          const randomData = randomBytes(outLength);
          const mem = this.getMemory();
          mem.set(randomData, outPtr);
        },
        clock_time_get: (a1: number | bigint, a2: number | bigint, out: WasmPtr) => {
          const outPtr = this.toJsNumber(out, 'clock_time_get');
          const ts = BigInt(new Date().getTime()) * 1000000n;
          const view = new DataView(this.getMemory().buffer);
          view.setBigUint64(outPtr, ts, true);
        },
        proc_exit: () => {
          this.logger('PANIC: proc_exit was called.');
          throw new Error();
        },
      },

      // These are functions implementations for imports we've defined are needed.
      // The native C++ build defines these in a module called "env". We must implement TypeScript versions here.
      env: {
        /**
         * The 'info' call we use for logging in C++, calls this under the hood.
         * The native code will just print to std:err (to avoid std::cout which is used for IPC).
         * Here we just emit the log line for the client to decide what to do with.
         */
        logstr: (addr: number) => {
          const str = this.stringFromAddress(addr);
          const m = this.getMemory();
          const str2 = `${str} (mem: ${(m.length / (1024 * 1024)).toFixed(2)}MiB)`;
          this.logger(str2);
        },

        throw_or_abort_impl: (addr: number) => {
          const str = this.stringFromAddress(addr);
          throw new Error(str);
        },

        get_data: (keyAddr: WasmPtr, outBufAddr: WasmPtr) => {
          const key = this.stringFromAddress(keyAddr);
          const data = this.memStore[key];
          if (!data) {
            this.logger(`get_data miss ${key}`);
            return;
          }
          // this.logger(`get_data hit ${key} size: ${data.length} dest: ${outBufAddr}`);
          // this.logger(Buffer.from(data.slice(0, 64)).toString('hex'));
          this.writeMemory(outBufAddr, data);
        },

        set_data: (keyAddr: WasmPtr, dataAddr: WasmPtr, dataLength: number | bigint) => {
          const key = this.stringFromAddress(keyAddr);
          const length = this.toJsNumber(dataLength as WasmPtr, 'set_data:length');
          this.memStore[key] = this.getMemorySlice(dataAddr, this.addPtr(dataAddr, length));
          // this.logger(`set_data: ${key} length: ${dataLength}`);
        },

        memory,
      },
    };
    /* eslint-enable camelcase */

    return importObj;
  }

  public exports(): any {
    return this.instance.exports;
  }

  public getPointerSizeBytes() {
    return this.pointerSize;
  }

  public isMemory64() {
    return this.memory64;
  }

  protected setMemory64(memory64: boolean) {
    this.memory64 = memory64;
    this.pointerSize = memory64 ? 8 : 4;
  }

  protected toWasmPtr(value: WasmPtr) {
    if (this.memory64) {
      return typeof value === 'bigint' ? value : BigInt(value);
    }
    if (typeof value === 'bigint') {
      return this.toJsNumber(value, 'toWasmPtr');
    }
    return value;
  }

  protected toWasmSize(value: number | bigint) {
    return this.toWasmPtr(value as WasmPtr);
  }

  protected toJsNumber(value: WasmPtr, context: string) {
    if (typeof value === 'bigint') {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`WASM pointer exceeds JS safe integer in ${context}.`);
      }
      return Number(value);
    }
    return value;
  }

  protected addPtr(ptr: WasmPtr, offset: number): WasmPtr {
    if (this.memory64) {
      return BigInt(ptr) + BigInt(offset);
    }
    return this.toJsNumber(ptr, 'addPtr') + offset;
  }

  protected readPointer(view: DataView, offset: number, littleEndian = true): WasmPtr {
    if (this.pointerSize === 8) {
      return view.getBigUint64(offset, littleEndian);
    }
    return view.getUint32(offset, littleEndian);
  }

  protected writePointer(view: DataView, offset: number, value: WasmPtr, littleEndian = true) {
    if (this.pointerSize === 8) {
      view.setBigUint64(offset, this.toWasmPtr(value) as bigint, littleEndian);
      return;
    }
    view.setUint32(offset, Number(this.toWasmPtr(value)), littleEndian);
  }

  protected readPointerFromMemory(ptr: WasmPtr, littleEndian = true): WasmPtr {
    const offset = this.toJsNumber(ptr, 'readPointerFromMemory');
    const view = new DataView(this.getMemory().buffer);
    return this.readPointer(view, offset, littleEndian);
  }

  protected writePointerToMemory(ptr: WasmPtr, value: WasmPtr, littleEndian = true) {
    const offset = this.toJsNumber(ptr, 'writePointerToMemory');
    const view = new DataView(this.getMemory().buffer);
    this.writePointer(view, offset, value, littleEndian);
  }

  protected readUint32FromMemory(ptr: WasmPtr, littleEndian = true) {
    const offset = this.toJsNumber(ptr, 'readUint32FromMemory');
    const view = new DataView(this.getMemory().buffer);
    return view.getUint32(offset, littleEndian);
  }

  protected writeUint32ToMemory(ptr: WasmPtr, value: number, littleEndian = true) {
    const offset = this.toJsNumber(ptr, 'writeUint32ToMemory');
    const view = new DataView(this.getMemory().buffer);
    view.setUint32(offset, value, littleEndian);
  }

  /**
   * When returning numeric values from WASM, use >>> to normalize unsigned i32 results.
   * BigInt returns (i64) are passed through unchanged.
   */
  public call(name: string, ...args: any) {
    if (!this.exports()[name]) {
      throw new Error(`WASM function ${name} not found.`);
    }
    try {
      const result = this.exports()[name](...args);
      if (typeof result === 'number') {
        return result >>> 0;
      }
      return result;
    } catch (err: any) {
      const message = `WASM function ${name} aborted, error: ${err}`;
      this.logger(message);
      this.logger(err.stack);
      throw err;
    }
  }

  public malloc(size: number): WasmPtr {
    return this.call('bbmalloc', this.toWasmSize(size));
  }

  public free(ptr: WasmPtr) {
    this.call('bbfree', this.toWasmPtr(ptr));
  }

  public memSize() {
    return this.getMemory().length;
  }

  /**
   * Returns a copy of the data, not a view.
   */
  public getMemorySlice(start: WasmPtr, end: WasmPtr) {
    const startIndex = this.toJsNumber(start, 'getMemorySlice:start');
    const endIndex = this.toJsNumber(end, 'getMemorySlice:end');
    return this.getMemory().subarray(startIndex, endIndex).slice();
  }

  public writeMemory(offset: WasmPtr, arr: Uint8Array) {
    const mem = this.getMemory();
    const offsetIndex = this.toJsNumber(offset, 'writeMemory');
    mem.set(arr, offsetIndex);
  }

  public getMemory() {
    return new Uint8Array(this.memory.buffer);
  }

  // PRIVATE METHODS

  private stringFromAddress(addr: WasmPtr) {
    addr = this.toJsNumber(addr, 'stringFromAddress') >>> 0;
    const m = this.getMemory();
    let i = addr;
    for (; m[i] !== 0; ++i);
    const textDecoder = new TextDecoder('ascii');
    return textDecoder.decode(m.slice(addr, i));
  }
}
