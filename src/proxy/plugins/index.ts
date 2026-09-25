/**
 * Proxy request plugins — the user-facing extension seam for outbound model
 * requests.
 *
 * Lazy ships the SEAM, not plugins. There is no built-in plugin and no
 * lazy.toml plugin registry: a project extends the proxy by dropping a module
 * into `.lazy/plugins/` (see ./loader.ts), and the contract that module has to
 * satisfy lives in ./types.ts. `lazy customize proxy-plugin <name>` scaffolds
 * one.
 */

export {
  loadProxyRequestPlugins,
  proxyPluginDir,
  ProxyPluginLoadError,
  PLUGIN_DIR_RELATIVE,
} from './loader';
export {
  applyRequestPlugins,
  type ProxyRequestPlugin,
  type ProxyRequestContext,
  type ApplyPluginsResult,
} from './types';
