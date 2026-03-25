// Global test setup for dashboard UI tests

// ResizeObserver is used by Lightweight Charts — not available in jsdom
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
