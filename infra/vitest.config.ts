import { defineConfig } from 'vitest/config';

// Synth bundles every Lambda with esbuild, so allow extra time
export default defineConfig({ test: { testTimeout: 180_000, hookTimeout: 180_000 } });
