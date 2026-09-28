// Pinned, public assets. Download only after the user requests offline preparation.
export const LIB_VERSION = '0.10.32';
export const LIB_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${LIB_VERSION}`;
export const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';
export const AI_ASSETS = [
  `${LIB_BASE}/vision_bundle.mjs`,
  `${LIB_BASE}/wasm/vision_wasm_internal.js`,
  `${LIB_BASE}/wasm/vision_wasm_internal.wasm`,
  `${LIB_BASE}/wasm/vision_wasm_nosimd_internal.js`,
  `${LIB_BASE}/wasm/vision_wasm_nosimd_internal.wasm`,
  MODEL_URL,
];
