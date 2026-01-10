const fs = require('fs').promises;
const path = require('path');

const PLUGINS_DIR = '/var/www/plugins';

/**
 * Get list of all installed plugins
 * @returns {Promise<{results: Array, count: number}>}
 */
async function getPlugins() {
  const plugins = [];

  // Check if plugins directory exists
  try {
    await fs.access(PLUGINS_DIR);
  } catch {
    return { results: [], count: 0 };
  }

  // Read all subdirectories
  const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
  const pluginDirs = entries.filter(entry => entry.isDirectory());

  // Read manifest.json from each plugin directory
  for (const dir of pluginDirs) {
    const manifestPath = path.join(PLUGINS_DIR, dir.name, 'manifest.json');
    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestContent);
      plugins.push(manifest);
    } catch (err) {
      // Skip plugins without valid manifest.json
      console.warn(`Skipping plugin ${dir.name}: ${err.message}`);
    }
  }

  return { results: plugins, count: plugins.length };
}

module.exports = {
  getPlugins
};
