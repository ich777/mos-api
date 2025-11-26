const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class HubService {
  constructor() {
    this.hubConfigPath = '/boot/config/system/hub.json';
  }

  /**
   * Ensures the hub.json file exists with default structure
   * @returns {Promise<void>}
   */
  async _ensureConfigExists() {
    try {
      await fs.access(this.hubConfigPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Create directory if it doesn't exist
        const dir = path.dirname(this.hubConfigPath);
        await fs.mkdir(dir, { recursive: true });

        // Create default config (empty array)
        await fs.writeFile(this.hubConfigPath, '[]', 'utf8');
      } else {
        throw error;
      }
    }
  }

  /**
   * Reads the hub configuration
   * @returns {Promise<Object>} The hub configuration
   */
  async _readConfig() {
    await this._ensureConfigExists();
    const data = await fs.readFile(this.hubConfigPath, 'utf8');
    return JSON.parse(data);
  }

  /**
   * Writes the hub configuration
   * @param {Object} config - The configuration to write
   * @returns {Promise<void>}
   */
  async _writeConfig(config) {
    await this._ensureConfigExists();
    await fs.writeFile(this.hubConfigPath, JSON.stringify(config, null, 2), 'utf8');
  }

  /**
   * Validates a git repository URL
   * @param {string} url - URL to validate
   * @returns {boolean} True if valid
   */
  _isValidGitUrl(url) {
    if (!url || typeof url !== 'string') {
      return false;
    }
    const trimmedUrl = url.trim();
    return trimmedUrl.startsWith('http://') ||
           trimmedUrl.startsWith('https://') ||
           trimmedUrl.startsWith('git');
  }

  /**
   * Gets all repository URLs
   * @returns {Promise<Array<string>>} List of repository URLs
   */
  async getRepositories() {
    try {
      const data = await this._readConfig();
      return Array.isArray(data) ? data : [];
    } catch (error) {
      throw new Error(`Error reading repositories: ${error.message}`);
    }
  }

  /**
   * Sets the repository URLs (replaces all)
   * @param {Array<string>} urls - Array of repository URLs
   * @returns {Promise<Array<string>>} The saved URLs
   */
  async setRepositories(urls) {
    try {
      if (!Array.isArray(urls)) {
        throw new Error('URLs must be an array');
      }

      // Validate and filter URLs
      const validUrls = [];
      for (const url of urls) {
        if (typeof url === 'string') {
          const trimmed = url.trim();
          if (this._isValidGitUrl(trimmed) && !validUrls.includes(trimmed)) {
            validUrls.push(trimmed);
          }
        }
      }

      await this._writeConfig(validUrls);
      return validUrls;
    } catch (error) {
      throw new Error(`Error saving repositories: ${error.message}`);
    }
  }

  /**
   * Extracts owner and repo name from URL for folder path
   * @param {string} url - Git repository URL
   * @returns {string} Folder path like 'owner/reponame'
   */
  _getRepoFolderPath(url) {
    try {
      // Remove .git suffix and trailing slashes
      let cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '');

      // Extract last two path segments (owner/repo)
      const parts = cleaned.split(/[\/:]/).filter(p => p && p !== 'https' && p !== 'http' && !p.includes('.'));

      if (parts.length >= 2) {
        const owner = parts[parts.length - 2];
        const repo = parts[parts.length - 1];
        return `${owner}/${repo}`;
      } else if (parts.length === 1) {
        return parts[0];
      }

      return `unknown/repo_${Date.now()}`;
    } catch {
      return `unknown/repo_${Date.now()}`;
    }
  }

  /**
   * Checks if a directory exists and is not empty
   * @param {string} dirPath - Directory path
   * @returns {Promise<boolean>} True if exists and has content
   */
  async _dirHasContent(dirPath) {
    try {
      const entries = await fs.readdir(dirPath);
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Clones a git repository into a directory
   * @param {string} url - Repository URL
   * @param {string} targetDir - Directory to clone into
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async _cloneRepo(url, targetDir) {
    try {
      const folderPath = this._getRepoFolderPath(url);
      const fullPath = path.join(targetDir, folderPath);

      // Create owner directory if needed
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      // Clone with depth 1, no interactive prompts
      const cmd = `GIT_TERMINAL_PROMPT=0 git clone --depth 1 "${url}" "${fullPath}" 2>&1`;
      await execPromise(cmd, { timeout: 120000 });

      return { success: true, folder: folderPath };
    } catch (error) {
      const errorMsg = error.stderr || error.stdout || error.message;

      // Check for auth/password issues
      if (errorMsg.includes('Authentication') ||
          errorMsg.includes('Password') ||
          errorMsg.includes('credential') ||
          errorMsg.includes('403') ||
          errorMsg.includes('401')) {
        console.warn(`Hub: Skipping ${url} - requires authentication`);
        return { success: false, error: 'requires authentication' };
      }

      // Check for invalid repo
      if (errorMsg.includes('not found') ||
          errorMsg.includes('does not exist') ||
          errorMsg.includes('Could not read') ||
          errorMsg.includes('fatal:')) {
        console.warn(`Hub: Skipping ${url} - not a valid git repository`);
        return { success: false, error: 'not a valid git repository' };
      }

      console.warn(`Hub: Failed to clone ${url}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Updates all repositories from hub.json
   * @returns {Promise<Object>} Update result with success/failed repos
   */
  async updateRepositories() {
    const reposPath = '/var/mos/hub/repositories';
    const tempPath = '/var/mos/hub/temp';

    // Get configured repositories
    const urls = await this.getRepositories();

    if (!urls || urls.length === 0) {
      throw new Error('No repositories configured');
    }

    const results = {
      success: [],
      failed: [],
      total: urls.length
    };

    // Check if repos directory has content
    const hasExistingRepos = await this._dirHasContent(reposPath);

    if (hasExistingRepos) {
      // Clone to temp directory first
      await fs.rm(tempPath, { recursive: true, force: true });
      await fs.mkdir(tempPath, { recursive: true });

      for (const url of urls) {
        const result = await this._cloneRepo(url, tempPath);

        if (result.success) {
          results.success.push(url);
        } else {
          results.failed.push({ url, error: result.error });
        }
      }

      // If at least one succeeded, swap directories
      if (results.success.length > 0) {
        // Remove old repos
        await fs.rm(reposPath, { recursive: true, force: true });

        // Move temp to repos
        await fs.rename(tempPath, reposPath);
      } else {
        // All failed, cleanup temp
        await fs.rm(tempPath, { recursive: true, force: true });
        throw new Error('All repository downloads failed');
      }
    } else {
      // No existing repos, clone directly
      await fs.mkdir(reposPath, { recursive: true });

      for (const url of urls) {
        const result = await this._cloneRepo(url, reposPath);

        if (result.success) {
          results.success.push(url);
        } else {
          results.failed.push({ url, error: result.error });
        }
      }

      if (results.success.length === 0) {
        throw new Error('All repository downloads failed');
      }
    }

    return results;
  }

  /**
   * Reads a JSON file safely
   * @param {string} filePath - Path to JSON file
   * @returns {Promise<Object|null>} Parsed JSON or null
   */
  async _readJsonFile(filePath) {
    try {
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Checks if a path exists
   * @param {string} p - Path to check
   * @returns {Promise<boolean>}
   */
  async _exists(p) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extracts container names and images from compose.yaml using yq
   * @param {string} composePath - Path to compose.yaml
   * @returns {Promise<Object>} Object with container_name: image pairs
   */
  async _parseComposeImages(composePath) {
    try {
      // Get all services with their container_name (or service name) and image
      const cmd = `yq '.services | to_entries | map({
        "name": ((.value.container_name // .key)),
        "image": .value.image
      })' "${composePath}" 2>/dev/null`;

      const { stdout } = await execPromise(cmd);
      const services = JSON.parse(stdout);

      const images = {};
      for (const svc of services) {
        if (svc.image) {
          images[svc.name] = svc.image;
        }
      }
      return images;
    } catch (error) {
      console.warn(`Hub: Failed to parse compose file ${composePath}: ${error.message}`);
      return {};
    }
  }

  /**
   * Gets git timestamps for a file (created and last modified)
   * @param {string} filePath - Path to file
   * @param {string} repoPath - Path to git repository root
   * @returns {Promise<{created_at: number|null, updated_at: number|null}>}
   */
  async _getGitTimestamps(filePath, repoPath) {
    try {
      // Get first commit timestamp (created)
      const createdCmd = `git log --format=%ct --diff-filter=A --follow -- "${filePath}" | tail -1`;
      const { stdout: createdOut } = await execPromise(createdCmd, { cwd: repoPath });
      const created_at = createdOut.trim() ? parseInt(createdOut.trim(), 10) : null;

      // Get last commit timestamp (updated)
      const updatedCmd = `git log -1 --format=%ct -- "${filePath}"`;
      const { stdout: updatedOut } = await execPromise(updatedCmd, { cwd: repoPath });
      const updated_at = updatedOut.trim() ? parseInt(updatedOut.trim(), 10) : null;

      return { created_at, updated_at };
    } catch {
      return { created_at: null, updated_at: null };
    }
  }

  /**
   * Processes a single docker template JSON
   * @param {string} jsonPath - Path to docker JSON
   * @param {Object} maintainerInfo - Maintainer info
   * @param {string} repoPath - Path to git repository root
   * @returns {Promise<Object|null>} Template object or null
   */
  async _processDockerTemplate(jsonPath, maintainerInfo, repoPath) {
    const template = await this._readJsonFile(jsonPath);
    if (!template) return null;

    // Validate category is an array
    const category = Array.isArray(template.category) ? template.category : null;

    // Get git timestamps
    const { created_at, updated_at } = await this._getGitTimestamps(jsonPath, repoPath);

    return {
      name: template.name || '',
      maintainer: maintainerInfo.maintainer || '',
      maintainer_donate: maintainerInfo.donation || '',
      donate: template.donate || '',
      support: template.support || '',
      type: 'docker',
      category,
      description: template.description || '',
      website: template.project || '',
      icon: template.icon || '',
      repository: template.repo || '',
      created_at,
      updated_at,
      stack_images: [],
      files: {
        template: jsonPath,
        yaml: null,
        env: null
      }
    };
  }

  /**
   * Processes a single compose template
   * @param {string} templateDir - Path to compose template directory
   * @param {Object} maintainerInfo - Maintainer info
   * @param {string} repoPath - Path to git repository root
   * @returns {Promise<Object|null>} Template object or null
   */
  async _processComposeTemplate(templateDir, maintainerInfo, repoPath) {
    const templatePath = path.join(templateDir, 'template.json');
    const composePath = path.join(templateDir, 'compose.yaml');
    const envPath = path.join(templateDir, '.env');

    const template = await this._readJsonFile(templatePath);
    if (!template) return null;

    // Parse compose.yaml for images
    let stackImages = {};
    const hasCompose = await this._exists(composePath);
    if (hasCompose) {
      stackImages = await this._parseComposeImages(composePath);
    }

    // Check if .env exists
    const hasEnv = await this._exists(envPath);

    // Validate category is an array
    const category = Array.isArray(template.category) ? template.category : null;

    // Get git timestamps
    const { created_at, updated_at } = await this._getGitTimestamps(templatePath, repoPath);

    return {
      name: template.name || '',
      maintainer: maintainerInfo.maintainer || '',
      maintainer_donate: maintainerInfo.donation || '',
      donate: template.donate || '',
      support: template.support || '',
      type: 'compose',
      category,
      description: template.description || '',
      website: template.website || '',
      icon: template.icon || '',
      repository: template.repository || '',
      created_at,
      updated_at,
      stack_images: Object.keys(stackImages).length > 0 ? [stackImages] : [],
      files: {
        template: templatePath,
        yaml: hasCompose ? composePath : null,
        env: hasEnv ? envPath : null
      }
    };
  }

  /**
   * Builds index of all templates from all repositories
   * @param {Object} options - Filter and sort options
   * @param {string} options.search - Search in name, maintainer, description
   * @param {string} options.category - Filter by category
   * @param {string} options.type - Filter by type (docker/compose)
   * @param {string} options.sort - Sort by field (name)
   * @param {string} options.order - Sort order (asc/desc)
   * @returns {Promise<Array>} Array of all templates
   */
  async buildIndex(options = {}) {
    const { search, category, type, sort, order = 'asc' } = options;
    const reposPath = '/var/mos/hub/repositories';
    const templates = [];
    const searchLower = search ? search.toLowerCase() : null;
    const categoryLower = category ? category.toLowerCase() : null;
    const typeLower = type ? type.toLowerCase() : null;

    // Check if repositories exist
    if (!await this._exists(reposPath)) {
      throw new Error('No repositories downloaded. Run update first.');
    }

    // Get all owner directories
    const owners = await fs.readdir(reposPath);

    for (const owner of owners) {
      const ownerPath = path.join(reposPath, owner);
      const ownerStat = await fs.stat(ownerPath);
      if (!ownerStat.isDirectory()) continue;

      // Get all repo directories under this owner
      const repos = await fs.readdir(ownerPath);

      for (const repo of repos) {
        const repoPath = path.join(ownerPath, repo);
        const repoStat = await fs.stat(repoPath);
        if (!repoStat.isDirectory()) continue;

        // Read maintainer.json
        const maintainerPath = path.join(repoPath, 'maintainer.json');
        const maintainerInfo = await this._readJsonFile(maintainerPath) || {};

        // Process docker templates
        const dockerPath = path.join(repoPath, 'docker');
        if (await this._exists(dockerPath)) {
          const dockerFiles = await fs.readdir(dockerPath);
          for (const file of dockerFiles) {
            if (file.endsWith('.json')) {
              const template = await this._processDockerTemplate(
                path.join(dockerPath, file),
                maintainerInfo,
                repoPath
              );
              if (template) templates.push(template);
            }
          }
        }

        // Process compose templates
        const composePath = path.join(repoPath, 'compose');
        if (await this._exists(composePath)) {
          const composeDirs = await fs.readdir(composePath);
          for (const dir of composeDirs) {
            const templateDir = path.join(composePath, dir);
            const dirStat = await fs.stat(templateDir);
            if (!dirStat.isDirectory()) continue;

            const template = await this._processComposeTemplate(
              templateDir,
              maintainerInfo,
              repoPath
            );
            if (template) templates.push(template);
          }
        }
      }
    }

    if (templates.length === 0) {
      throw new Error('No templates found in repositories');
    }

    // Filter results
    let filtered = templates;

    // Filter by type (docker/compose)
    if (typeLower) {
      filtered = filtered.filter(t => t.type === typeLower);
    }

    // Filter by search term (name, maintainer, description)
    if (searchLower) {
      filtered = filtered.filter(t => {
        const name = (t.name || '').toLowerCase();
        const maintainer = (t.maintainer || '').toLowerCase();
        const description = (t.description || '').toLowerCase();

        return name.includes(searchLower) ||
               maintainer.includes(searchLower) ||
               description.includes(searchLower);
      });
    }

    // Filter by category
    if (categoryLower) {
      filtered = filtered.filter(t => {
        if (!Array.isArray(t.category)) return false;
        return t.category.some(c => c.toLowerCase().includes(categoryLower));
      });
    }

    if (filtered.length === 0) {
      const filters = [search, category, type].filter(Boolean).join(', ');
      throw new Error(`No templates found matching "${filters}"`);
    }

    // Sort results
    if (sort) {
      filtered.sort((a, b) => {
        let valA, valB;

        switch (sort) {
          case 'name':
            valA = (a.name || '').toLowerCase();
            valB = (b.name || '').toLowerCase();
            if (order === 'desc') {
              return valB.localeCompare(valA);
            }
            return valA.localeCompare(valB);

          case 'created':
            valA = a.created_at || 0;
            valB = b.created_at || 0;
            break;

          case 'updated':
            valA = a.updated_at || 0;
            valB = b.updated_at || 0;
            break;

          default:
            return 0;
        }

        // For timestamp sorting (created/updated)
        if (sort === 'created' || sort === 'updated') {
          if (order === 'desc') {
            return valB - valA; // newest first
          }
          return valA - valB; // oldest first
        }

        return 0;
      });
    }

    return filtered;
  }

  /**
   * Gets a docker template by its file path
   * @param {string} templatePath - Absolute path to template JSON
   * @returns {Promise<Object>} The template content
   */
  async getDockerTemplate(templatePath) {
    if (!templatePath) {
      throw new Error('Template path is required');
    }

    // Security: ensure path is within repositories
    const reposPath = '/var/mos/hub/repositories';
    if (!templatePath.startsWith(reposPath)) {
      throw new Error('Invalid template path');
    }

    if (!await this._exists(templatePath)) {
      throw new Error('Template not found');
    }

    const template = await this._readJsonFile(templatePath);
    if (!template) {
      throw new Error('Failed to read template');
    }

    return template;
  }

  /**
   * Gets compose files by their paths
   * @param {string} templatePath - Absolute path to template.json
   * @param {string} yamlPath - Absolute path to compose.yaml
   * @param {string} envPath - Optional absolute path to .env
   * @returns {Promise<Object>} Object with name, yaml, env, icon
   */
  async getComposeFiles(templatePath, yamlPath, envPath = null) {
    if (!templatePath) {
      throw new Error('Template path is required');
    }
    if (!yamlPath) {
      throw new Error('YAML path is required');
    }

    // Security: ensure paths are within repositories
    const reposPath = '/var/mos/hub/repositories';
    if (!templatePath.startsWith(reposPath)) {
      throw new Error('Invalid template path');
    }
    if (!yamlPath.startsWith(reposPath)) {
      throw new Error('Invalid yaml path');
    }
    if (envPath && !envPath.startsWith(reposPath)) {
      throw new Error('Invalid env path');
    }

    if (!await this._exists(templatePath)) {
      throw new Error('Template not found');
    }
    if (!await this._exists(yamlPath)) {
      throw new Error('YAML file not found');
    }

    // Read template.json for name and icon
    const template = await this._readJsonFile(templatePath);

    const result = {
      name: template?.name || null,
      yaml: null,
      env: null,
      icon: template?.icon || null
    };

    // Read yaml content
    try {
      result.yaml = await fs.readFile(yamlPath, 'utf8');
    } catch (error) {
      throw new Error('Failed to read YAML file');
    }

    // Read env content if provided
    if (envPath && await this._exists(envPath)) {
      try {
        result.env = await fs.readFile(envPath, 'utf8');
      } catch {
        result.env = null;
      }
    }

    return result;
  }
}

module.exports = new HubService();
