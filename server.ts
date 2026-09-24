// Root entry shim: opencode's local plugin resolver (Host.resolve) probes
// <dir>/server or <dir>/index at the package root for directory plugins and
// does not consult package.json "exports" for absolute-path targets.
// The real plugin lives in src/server.ts.
export { default } from "./src/server"
