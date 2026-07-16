// Keep the startup board request pending so the TUI's input readiness can be
// tested independently of network speed. loadDashboardData() has its own 5s
// timeout; the regression test must be able to quit long before that fires.
globalThis.fetch = () => new Promise(() => {});
