import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each DOM fixture loads its own editor/renderer. On high-core laptops the
    // CPU-derived default oversubscribes memory and makes module-loading hooks
    // time out, leaving their async work to contaminate subsequent assertions.
    // Bound concurrency without skipping tests or relaxing assertion deadlines.
    maxWorkers: Math.min(4, availableParallelism()),
  },
});
