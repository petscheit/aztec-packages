---
title: "WASM Memory64 feasibility for Barretenberg proving"
description: "Feasibility report for enabling Memory64 in bb.js, including required changes, risks, and a phased plan."
---

## Overview

This report summarizes what it would take to add Memory64 support to the Barretenberg WASM prover used by Noir via `bb.js`.
Today the browser and Node.js WASM builds are `wasm32` and assume 32-bit pointers, which caps addressable memory at 4GB.
Memory64 can raise the theoretical cap, but it requires coordinated changes in the C++ toolchain, the WASM ABI, and the
TypeScript runtime that currently marshals 32-bit pointers and sizes.

The short version: this is a medium-to-high effort change because it spans C++ build tooling, wasm exports, and JS/TS
bindings. The highest-risk area is JS/TS integration (pointer sizes, `BigInt` plumbing, and runtime support in browsers).

## Current WASM architecture (relevant constraints)

### Build and packaging

- The WASM artifacts are built via CMake presets using the `wasm32-wasi` toolchain (`cmake/toolchains/wasm32-wasi.cmake`).
  The preset `wasm` and `wasm-threads` are wired for WASI SDK and `wasm32`.【F:barretenberg/cpp/CMakePresets.json†L381-L418】【F:barretenberg/cpp/cmake/toolchains/wasm32-wasi.cmake†L1-L3】
- CMake treats `wasm32` specially by checking the system processor and toggling WASM-related flags and definitions
  (`DISABLE_ASM`, `OMP_MULTITHREADING`, `ENABLE_WASM_BENCH`, `_WASI_EMULATED_PROCESS_CLOCKS`).【F:barretenberg/cpp/CMakeLists.txt†L97-L107】
- The `bb.js` package copies `barretenberg.wasm.gz` and `barretenberg-threads.wasm.gz` from the C++ build outputs into the
  TS package `dest/` folders for Node and browser usage.【F:barretenberg/ts/scripts/copy_wasm.sh†L8-L25】

### Runtime memory model (TypeScript)

- `BarretenbergWasmMain` creates a `WebAssembly.Memory` using `initial` and `maximum` pages and a shared flag; it defaults
  to a maximum of `2 ** 16` pages (4GB) on non-iOS, and a smaller cap on iOS.【F:barretenberg/ts/src/barretenberg_wasm/barretenberg_wasm_main/index.ts†L34-L94】
- `bb.js` exposes a memory configuration option in browser usage documentation and initializes WASM in worker mode by
  default, with shared memory and threads when available.【F:barretenberg/docs/docs/how_to_guides/on-the-browser.md†L80-L135】【F:barretenberg/ts/src/barretenberg_wasm/barretenberg_wasm_main/index.ts†L34-L85】
- The package supports single-threaded and multi-threaded WASM builds and falls back based on platform and isolation
  requirements (COOP/COEP).【F:barretenberg/ts/README.md†L3-L15】【F:barretenberg/docs/docs/how_to_guides/on-the-browser.md†L80-L101】

### 32-bit pointer assumptions that block Memory64

These are the most direct blockers that must be changed to support 64-bit pointers:

- The heap allocator explicitly assumes 32-bit pointer width for variable-length outputs (`4` bytes).【F:barretenberg/ts/src/barretenberg_wasm/barretenberg_wasm_main/heap_allocator.ts†L41-L55】
- The main wasm call path reads output pointers and sizes via `getUint32` and writes 32-bit values into the scratch
  buffer for msgpack outputs.【F:barretenberg/ts/src/barretenberg_wasm/barretenberg_wasm_main/index.ts†L167-L233】
- The generic wasm call wrapper forces return values into unsigned 32-bit numbers (`>>> 0`).【F:barretenberg/ts/src/barretenberg_wasm/barretenberg_wasm_base/index.ts†L90-L105】
- The runtime uses `Uint8Array` views of `memory.buffer`, which are 32-bit indexed, and truncates addresses with
  `>>> 0` in helper methods like `stringFromAddress`.【F:barretenberg/ts/src/barretenberg_wasm/barretenberg_wasm_base/index.ts†L118-L136】

## What Memory64 changes in practice

Memory64 affects all of the following:

1. **Toolchain and ABI**: WASM modules must be compiled for `wasm64` with Memory64 enabled. That changes pointer size
   (`size_t`, `uintptr_t`, `void*`) and updates the ABI for all exports and imports.
2. **JS/TS interop**: In the JS API, `i64` parameters and return values are represented as `BigInt`. Any function
   that passes pointers or sizes between JS and WASM must move from 32-bit numbers to 64-bit `BigInt` values.
3. **Memory access**: Typed array views in JS are limited to 4GB. If the memory grows beyond 4GB, direct JS access
   may need chunking strategies or alternative APIs to avoid trying to view the entire memory buffer at once.
4. **Runtime support**: Memory64 is new and not uniformly available in all browser and Node.js versions. The system
   will need feature detection and a fallback to `wasm32` for unsupported targets.

## Required changes (by area)

### 1. C++ build system and toolchain

**Goal:** Produce a `wasm64` build (and `wasm64-threads` build) alongside the existing `wasm32` artifacts.

**Instructions:**

- Add a new toolchain file, e.g. `cmake/toolchains/wasm64-wasi.cmake`, that sets
  `CMAKE_SYSTEM_PROCESSOR` to `wasm64` and enables Memory64 in the compiler and linker flags.
  The exact flag depends on your WASI SDK / clang version (often `-mwasm64` or `-mwasm-memory64`).
  Use the existing `wasm32` toolchain as the template.【F:barretenberg/cpp/cmake/toolchains/wasm32-wasi.cmake†L1-L3】
- Add new presets to `CMakePresets.json`:
  - `wasm64` (single-threaded)
  - `wasm64-threads` (shared-memory build)
  These should mirror `wasm` and `wasm-threads` but use the new toolchain file and memory64 flags.【F:barretenberg/cpp/CMakePresets.json†L381-L418】
- Update `CMakeLists.txt` so that the WASM configuration also triggers for `wasm64` (not just `wasm32`), and ensure
  the `WASM` flag is set for both processors.【F:barretenberg/cpp/CMakeLists.txt†L97-L107】
- Extend `cpp/bootstrap.sh` and `ts/scripts/copy_wasm.sh` to build and package the new wasm64 artifacts alongside the
  existing wasm32 outputs.【F:barretenberg/cpp/bootstrap.sh†L120-L142】【F:barretenberg/ts/scripts/copy_wasm.sh†L8-L25】

### 2. JS/TS memory and pointer plumbing (largest effort)

**Goal:** Make bb.js work with 64-bit pointers and sizes while preserving wasm32 compatibility.

**Instructions (core changes):**

- Update pointer-size assumptions in:
  - `HeapAllocator` output pointer sizes and the variable-length output logic.【F:barretenberg/ts/src/barretenberg_wasm/barretenberg_wasm_main/heap_allocator.ts†L41-L55】
  - `BarretenbergWasmMain.getOutputArgs()` to read 64-bit pointers and sizes, likely using `getBigUint64` and
    handling `BigInt` values before slicing memory.【F:barretenberg/ts/src/barretenberg_wasm/barretenberg_wasm_main/index.ts†L167-L233】
  - `BarretenbergWasmBase.call()` to avoid forcing `>>> 0` and instead return raw values, since wasm64 exports
    will return `BigInt` for `i64` results.【F:barretenberg/ts/src/barretenberg_wasm/barretenberg_wasm_base/index.ts†L90-L105】
  - `stringFromAddress()` and other helpers to accept 64-bit addresses without truncation.【F:barretenberg/ts/src/barretenberg_wasm/barretenberg_wasm_base/index.ts†L129-L136】
- Introduce a compatibility layer that can operate in both wasm32 and wasm64 modes:
  - Detect memory64 support at runtime and select the appropriate wasm binary and pointer width.
  - Add a `supportsMemory64()` helper (feature detection for `WebAssembly.Memory` + `memory64` support).
- Add new `barretenberg[-threads]-memory64.wasm.gz` artifacts and update `fetch_code` to select the wasm64 variant
  when supported (and fall back to wasm32).【F:barretenberg/ts/src/barretenberg_wasm/fetch_code/browser/index.ts†L3-L33】

### 3. C++ ABI and serialization considerations

**Goal:** Ensure exported functions and buffer protocols remain valid with 64-bit pointers.

**Instructions:**

- Review CBind exports that pass pointers and sizes (`uint8_t**`, `size_t*`) and ensure the JS side handles 64-bit
  pointers and sizes. The msgpack helper uses `size_t` for lengths and returns an allocated buffer pointer, so JS
  must treat both as 64-bit in wasm64.【F:barretenberg/cpp/src/barretenberg/serialize/msgpack_impl.hpp†L53-L78】
- Decide whether to keep the current 32-bit length-prefix format (`serialize.hpp` writes vector lengths as `uint32_t`)
  or introduce a new 64-bit length prefix for very large outputs. The current format caps output sizes at 4GB, even if
  total memory increases.【F:barretenberg/cpp/src/barretenberg/common/serialize.hpp†L212-L299】

### 4. Runtime support and browser constraints

**Goal:** Maintain compatibility across browsers/Node while unlocking higher memory where supported.

**Instructions:**

- Add feature detection to decide whether to load wasm64 binaries; otherwise fall back to wasm32.
- Keep the COOP/COEP requirements for multithreading in the browser, as `SharedArrayBuffer` is still required and
  documented for bb.js today.【F:barretenberg/ts/README.md†L12-L15】【F:barretenberg/docs/docs/how_to_guides/on-the-browser.md†L80-L101】
- Document any runtime constraints for Memory64 (minimum browser/Node version, required flags, or unsupported targets).

### 5. Testing and benchmarks

**Goal:** Validate correctness and memory scaling in browser and Node for both wasm32 and wasm64.

**Instructions:**

- Extend existing benchmarks to include wasm64 runs where supported; the browser memory benchmark is already in place
  and can be reused for higher memory targets.【F:barretenberg/cpp/scripts/ci_benchmark_browser_memory.sh†L1-L48】
- Add a wasm64 CI job (if possible) that compiles the wasm64 artifacts and executes at least the existing wasm tests
  (e.g. `ecc_tests` and a minimal `bb.js` proving flow).

## Suggested phased plan

### Phase 0: Research and capability matrix (low effort)

- Confirm Memory64 support in the target environments (browser versions and Node.js versions).
- Identify the exact WASI SDK/clang flags needed to build wasm64.

### Phase 1: Build pipeline and artifacts (medium effort)

- Add wasm64 toolchain and presets.
- Produce wasm64 builds for single-threaded and multithreaded variants.
- Package the artifacts alongside wasm32 in `bb.js`.

### Phase 2: JS/TS runtime compatibility (high effort)

- Implement dual-mode pointer handling (32-bit and 64-bit).
- Replace `Uint32` pointer reads/writes with `BigInt` where needed.
- Make all pointer arithmetic safe for both modes.

### Phase 3: Validation and rollout (medium effort)

- Run wasm64 in browser and Node.js with representative proving workloads.
- Compare memory usage and ensure stability at >4GB targets.
- Update docs and feature flags for production use.

## Difficulty assessment

**Overall difficulty: medium to high.** The build changes are straightforward, but the JS/TS runtime layer has many
32-bit assumptions that must be replaced with dual-mode pointer handling. Additionally, Memory64 runtime support is
still new, so compatibility and testing are likely to be the slowest parts of the project.

If the goal is “best-effort 16GB in the browser,” the limiting factor is likely browser memory allocation limits and
Memory64 support rather than the Barretenberg core logic. The most pragmatic path is to add wasm64 support in a
feature-gated way while keeping wasm32 as the default fallback.
