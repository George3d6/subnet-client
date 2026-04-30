'use strict';
/**
 * Node-only adapter — re-exports the handful of `node:*` modules other parts
 * of the package need so the browser build can stub them out via the
 * `#node-only` import condition in package.json. Anything that needs the
 * filesystem, path math, or homedir lookup goes through here so a browser
 * bundler never has to walk those imports.
 */

module.exports = {
  fs: require('fs'),
  path: require('path'),
  os: require('os'),
};
