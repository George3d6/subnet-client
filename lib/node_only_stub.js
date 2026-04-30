'use strict';
/**
 * Browser stub for `#node-only`. The real Node version exports `fs`, `path`,
 * and `os`; here those slots are null. Code that only opportunistically
 * touches them (e.g. computing a default state directory) can defensively
 * check for null. Code that *requires* them — `setAvatar(filePath)` reading
 * a local file — should throw a clear "not available in the browser" error
 * at the call site rather than silently no-op.
 */

module.exports = {
  fs: null,
  path: null,
  os: null,
};
