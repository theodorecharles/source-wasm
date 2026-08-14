#include <stdint.h>

/*
 * Original, deliberately engine-free diagnostic module. It proves that this
 * repository's Emscripten artifact is executable without misrepresenting an
 * unavailable Source engine as a port.
 */

__attribute__((used, visibility("default")))
uint32_t source_wasm_boundary_version(void) {
    return 0x000701u;
}

__attribute__((used, visibility("default")))
uint32_t source_wasm_has_engine(void) {
    return 0u;
}

