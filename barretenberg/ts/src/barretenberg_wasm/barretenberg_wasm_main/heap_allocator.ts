import { type BarretenbergWasmMain } from './index.js';
import { type WasmPtr } from '../barretenberg_wasm_base/index.js';

/**
 * Keeps track of heap allocations so they can be easily freed.
 * The WASM memory layout has 1024 bytes of unused "scratch" space at the start (addresses 0-1023).
 * We can leverage this for IO rather than making expensive bb_malloc bb_free calls.
 * Heap allocations will be created for input/output args that don't fit into the scratch space.
 * Input scratch grows UP from 0, output scratch grows DOWN from 1024, meeting in the middle.
 * This maximizes space utilization while preventing overlap.
 */
export class HeapAllocator {
  private allocs: WasmPtr[] = [];
  private inScratchPtr = 0; // Next input starts here, grows UP
  private outScratchPtr = 1024; // Next output ends here, grows DOWN

  constructor(private wasm: BarretenbergWasmMain) {}

  getInputs(buffers: (Uint8Array | number)[]) {
    return buffers.map(bufOrNum => {
      if (typeof bufOrNum === 'object') {
        const size = bufOrNum.length;
        // Check if there's room in scratch space (inputs grow up, outputs grow down)
        if (this.inScratchPtr + size <= this.outScratchPtr) {
          const ptr = this.inScratchPtr;
          this.inScratchPtr += size; // Grow UP
          this.wasm.writeMemory(ptr, bufOrNum);
          return ptr;
        } else {
          // Fall back to heap allocation
          const ptr = this.wasm.malloc(size);
          this.wasm.writeMemory(ptr, bufOrNum);
          this.allocs.push(ptr);
          return ptr;
        }
      } else {
        return bufOrNum;
      }
    });
  }

  getOutputPtrs(outLens: (number | undefined)[]) {
    return outLens.map(len => {
      // If the obj is variable length, we need a 4 byte ptr to write the serialized data address to.
      // For Memory64, the pointer width is 8 bytes.
      const size = len ?? this.wasm.getPointerSizeBytes();

      // Check if there's room in scratch space (inputs grow up, outputs grow down)
      if (this.inScratchPtr + size <= this.outScratchPtr) {
        this.outScratchPtr -= size; // Grow DOWN
        return this.outScratchPtr;
      } else {
        // Fall back to heap allocation
        const ptr = this.wasm.malloc(size);
        this.allocs.push(ptr);
        return ptr;
      }
    });
  }

  addOutputPtr(ptr: WasmPtr) {
    // Only add to dealloc list if it's a heap allocation (not in scratch space 0-1023)
    if (!this.isScratchPtr(ptr)) {
      this.allocs.push(ptr);
    }
  }

  freeAll() {
    for (const ptr of this.allocs) {
      this.wasm.free(ptr);
    }
  }

  private isScratchPtr(ptr: WasmPtr) {
    return typeof ptr === 'bigint' ? ptr < 1024n : ptr < 1024;
  }
}
