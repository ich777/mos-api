const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const axios = require('axios');

// Promisify exec for easier use with async/await
const execPromise = util.promisify(exec);

class DockerService {

  /**
   * Reads the Docker containers file and checks for available updates
   * @returns {Promise<Array>} Array of Docker images with update status
   */
  async getDockerImages() {
    try {
      // Path to containers.json
      const filePath = '/var/lib/docker/mos/containers';

      // Read file
      const data = await fs.readFile(filePath, 'utf8');
      const images = JSON.parse(data);

      // Process each image and add update status
      return images.map(image => {
        const updateAvailable = image.local !== image.remote;

        return {
          ...image,
          update_available: updateAvailable
        };
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('containers file not found');
      }
      throw new Error(`Error reading containers: ${error.message}`);
    }
  }

  /**
   * Executes the Docker update script
   * @param {string} [name] - Optional name of the container to update
   * @returns {Promise<Object>} Result of the update check
   */
  async checkForUpdates(name = null) {
    try {
      // Path to update script
      const scriptPath = '/usr/local/bin/mos-check_for_docker_updates';

      // Command with or without parameter
      const command = name ? `${scriptPath} ${name}` : scriptPath;

      // Execute command
      const { stdout, stderr } = await execPromise(command);

      if (stderr) {
        throw new Error(`Error executing update check: ${stderr}`);
      }

      // Try to parse the output as JSON, if possible
      try {
        return JSON.parse(stdout);
      } catch (parseError) {
        // If no JSON output, return text
        return { message: stdout.trim() };
      }
    } catch (error) {
      throw new Error(`Failed to check for updates: ${error.message}`);
    }
  }

  /**
   * Executes the Docker restart
   * @param {string} [name] - Name of the container to restart
   */
  async Restart(name) {
    try {
      // Path to update script
      const dockerPath = '/usr/bin/docker';

      // Check if name is not empty
      if (!name) {
        throw new Error('Name is required');
      }

      // Command with or without parameter
      const command = `${dockerPath} container stop ${name} && ${dockerPath} container start ${name}`;

      // Execute command
      const { stdout, stderr } = await execPromise(command);

      if (stderr) {
        throw new Error(`Error restarting: ${stderr}`);
      }

      // Try to parse the output as JSON, if possible
      return {
        success: true
      };
    } catch (error) {
      throw new Error(`Failed to restart: ${error.message}`);
    }
  }

  /**
   * Executes the Docker upgrade script
   * @param {string} [name] - Optional name of the container to update
   * @returns {Promise<Object>} Result of the upgrade process
   */
  async Upgrade(name = null) {
    try {

      // Path to update script
      const scriptPath = '/usr/local/bin/mos-update_containers';

      // Command with or without parameter
      const command = name ? `${scriptPath} ${name}` : scriptPath;

      // Execute command
      const { stdout, stderr } = await execPromise(command);

      if (stderr) {
        throw new Error(`Error executing upgrade: ${stderr}`);
      }


      // Try to parse the output as JSON, if possible
      try {
        const result = JSON.parse(stdout);
        return result;
      } catch (parseError) {
        // If no JSON output, return text
        const result = { message: stdout.trim() };
        return result;
      }
    } catch (error) {
      throw new Error(`Failed to upgrade: ${error.message}`);
    }
  }

  /**
   * Updates container indices with new values
   * @param {Array} containers - Array of containers with name and new index
   * @returns {Promise<Array>} Updated container list
   */
  async updateContainerIndices(containers) {
    try {
      // Path to containers file
      const filePath = '/var/lib/docker/mos/containers';

      // Read current file
      const data = await fs.readFile(filePath, 'utf8');
      const currentContainers = JSON.parse(data);

      // Create a map of names to new properties (index and wait)
      const updateMap = {};
      containers.forEach(container => {
        if (container.name) {
          updateMap[container.name] = {
            ...(container.index !== undefined && { index: container.index }),
            ...(container.autostart !== undefined && { autostart: container.autostart }),
            ...(container.wait !== undefined && { wait: container.wait })
          };
        }
      });

      // Update properties in the current container list
      const updatedContainers = currentContainers.map(container => {
        if (updateMap.hasOwnProperty(container.name)) {
          return {
            ...container,
            ...updateMap[container.name]
          };
        }
        return container;
      });

      // Write the updated container list back to the file
      await fs.writeFile(filePath, JSON.stringify(updatedContainers, null, 2), 'utf8');

      return updatedContainers;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('containers file not found');
      }
      throw new Error(`Error updating container indices: ${error.message}`);
    }
  }

  /**
   * Validates a container template
   * @param {Object} template - The template to validate
   * @throws {Error} If validation fails
   */
  validateContainerTemplate(template) {
    // Check required fields
    if (!template.name) {
      throw new Error('Name is required');
    }
    if (!template.repo) {
      throw new Error('Repository is required');
    }

    // Validate paths if present
    if (template.paths) {
      if (!Array.isArray(template.paths)) {
        throw new Error('Paths must be an array');
      }

      template.paths.forEach((path, index) => {
        // Skip empty objects
        if (!path || Object.keys(path).length === 0) {
          return;
        }

        if (!path.host || !path.container) {
          throw new Error(`Path ${index + 1} is missing required fields (host, container`);
        }
      });
    }

    // Validate ports if present
    if (template.ports) {
      if (!Array.isArray(template.ports)) {
        throw new Error('Ports must be an array');
      }

      template.ports.forEach((port, index) => {
        // Skip empty objects
        if (!port || Object.keys(port).length === 0) {
          return;
        }

        if (!port.host || !port.container) {
          throw new Error(`Port ${index + 1} is missing required fields (host, container)`);
        }
      });
    }

    // Validate labels if present
    if (template.labels) {
      if (!Array.isArray(template.labels)) {
        throw new Error('Labels must be an array');
      }

      template.labels.forEach((label, index) => {
        // Skip empty objects
        if (!label || Object.keys(label).length === 0) {
          return;
        }

        if (!label.key || !label.value) {
          throw new Error(`Label ${index + 1} is missing required fields (key, value)`);
        }
      });
    }

    // Validate devices if present
    if (template.devices) {
      if (!Array.isArray(template.devices)) {
        throw new Error('Devices must be an array');
      }

      template.devices.forEach((device, index) => {
        // Skip empty objects
        if (!device || Object.keys(device).length === 0) {
          return;
        }

        if (!device.host || !device.container) {
          throw new Error(`Device ${index + 1} is missing required fields (host, container)`);
        }
      });
    }

    return true;
  }

  /**
   * Creates a new container from template
   * @param {Object} template - The container template
   * @returns {Promise<Object>} Result of the container creation
   */
  async createContainer(template) {
    try {
      // Ensure required directories exist, create them if they don't
      const requiredDirs = [
        '/boot/config/system/docker/templates',
        '/boot/config/system/docker/removed'
      ];

      for (const dir of requiredDirs) {
        try {
          await fs.access(dir);
        } catch (err) {
          if (err.code === 'ENOENT') {
            // Directory doesn't exist, create it recursively
            try {
              await fs.mkdir(dir, { recursive: true });
            } catch (mkdirErr) {
              throw new Error(`Failed to create required directory: ${dir}. Error: ${mkdirErr.message}`);
            }
          } else {
            throw new Error(`Cannot access directory: ${dir}. Error: ${err.message}`);
          }
        }
      }

      // Validate the template
      this.validateContainerTemplate(template);

      // Create filename
      const fileName = `${template.name.replace(/[^A-Za-z0-9\-_.]/g, '_')}.json`;
      const filePath = path.join('/boot/config/system/docker/templates', fileName);

      // Check if file already exists to determine if we need recreate_container parameter
      let templateExists = false;
      try {
        await fs.access(filePath);
        templateExists = true;
      } catch (err) {
        // File doesn't exist, we can proceed with normal creation
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }

      // Write template to file (overwrite if exists)
      await fs.writeFile(filePath, JSON.stringify(template, null, 2), 'utf8');

      // Execute deploy script with recreate_container parameter if template existed
      const scriptPath = '/usr/local/bin/mos-deploy_docker';
      let command = `${scriptPath} ${fileName}`;

      if (templateExists) {
        command += ' recreate_container';
      }

      let deploymentSuccessful = false;
      let stdout = '';
      try {
        const { stdout: deployStdout, stderr } = await execPromise(command, {
          cwd: '/boot/config/system/docker/templates'
        });

        stdout = deployStdout; // Store stdout in broader scope

        // Note: stderr may contain Docker pull progress, which is normal
        // We only check if the container was actually created, not stderr content

        // Verify that the container was actually created by checking if it exists
        try {
          const containerCheckResponse = await axios({
            method: 'GET',
            url: `http://localhost/containers/${template.name}/json`,
            socketPath: '/var/run/docker.sock',
            validateStatus: () => true,
            timeout: 5000
          });

          if (containerCheckResponse.status === 200) {
            deploymentSuccessful = true;
          } else {
            throw new Error(`Container '${template.name}' was not created successfully`);
          }
        } catch (verifyError) {
          throw new Error(`Container verification failed: ${verifyError.message}`);
        }

      } catch (deployError) {
        // Deployment failed - keep template for user to edit and retry
        // Template remains available for correction and redeployment
        const enhancedError = new Error(`Container deployment failed: ${deployError.message}. Template has been saved and can be edited for retry.`);
        enhancedError.templateSaved = true;
        enhancedError.templatePath = filePath;
        throw enhancedError;
      }

      // If deployment was successful, check and remove any template with same name from removed directory
      let removedOldTemplate = false;
      try {
        const removedDir = '/boot/config/system/docker/removed';
        const removedFilePath = path.join(removedDir, fileName);

        // Check if a template with the same name exists in removed directory
        try {
          await fs.access(removedFilePath);
          // File exists, delete it since we successfully created a new container with same name
          await fs.unlink(removedFilePath);
          removedOldTemplate = true;
        } catch (accessError) {
          // File doesn't exist in removed directory, which is fine
        }
      } catch (cleanupError) {
        // Don't fail the main operation if cleanup fails, just continue
      }

      try {
        const result = JSON.parse(stdout);

        // Add information about removed old template
        if (removedOldTemplate) {
          result.message = `${result.message || 'Container created successfully'}. Old removed template was automatically cleaned up.`;
        }

        return result;
      } catch (parseError) {
        const result = { message: stdout.trim() };

        // Add information about removed old template
        if (removedOldTemplate) {
          result.message = `${result.message}. Old removed template was automatically cleaned up.`;
        }

        return result;
      }
    } catch (error) {
      throw new Error(`Container creation failed: ${error.message}`);
    }
  }

  /**
   * Removes a container and moves its template to the removed directory
   * @param {string} name - The name of the container to remove
   * @returns {Promise<Object>} Result of the removal process
   */
  async removeContainer(name) {
    try {

      const templateDir = '/boot/config/system/docker/templates';
      const removedDir = '/boot/config/system/docker/removed';
      const fileName = `${name}.json`;
      const templatePath = path.join(templateDir, fileName);
      const removedPath = path.join(removedDir, fileName);

      // Check if template exists (but don't fail if it doesn't)
      let templateExists = true;
      let templateWarning = null;
      try {
        await fs.access(templatePath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          templateExists = false;
          templateWarning = `Container template '${name}' not found, but proceeding with container cleanup`;
        } else {
          throw err;
        }
      }

      // Create removed directory if it doesn't exist
      try {
        await fs.access(removedDir);
      } catch (err) {
        if (err.code === 'ENOENT') {
          await fs.mkdir(removedDir, { recursive: true });
        }
      }

      // Stop and remove the container
      try {
        await execPromise(`docker stop ${name}`);
      } catch (error) {
        // Ignore error if container is not running
      }

      try {
        await execPromise(`docker rm ${name}`);
      } catch (error) {
        // Ignore error if container doesn't exist
      }

      let warning = templateWarning;

      // Read template to get repository information before removing image (only if template exists)
      let repositoryToRemove = null;
      if (templateExists) {
        try {
          const templateData = await fs.readFile(templatePath, 'utf8');
          const template = JSON.parse(templateData);
          repositoryToRemove = template.repo;
        } catch (templateReadError) {
          warning = warning ?
            `${warning}; Could not read template to get repository info: ${templateReadError.message}` :
            `Could not read template to get repository info: ${templateReadError.message}`;
        }
      } else {
        warning = warning ?
          `${warning}; Could not remove image because template is missing` :
          'Could not remove image because template is missing';
      }

      // Remove the container image using the repository from template
      if (repositoryToRemove) {
        try {
          await execPromise(`docker rmi ${repositoryToRemove}`);
        } catch (error) {
          // Check if error is due to image being used by other containers
          if (error.message.includes('image is being used by')) {
            warning = warning ?
              `${warning}; Image could not be removed as it is being used by other containers` :
              'Image could not be removed as it is being used by other containers';
          } else {
            warning = warning ?
              `${warning}; Failed to remove image ${repositoryToRemove}: ${error.message}` :
              `Failed to remove image ${repositoryToRemove}: ${error.message}`;
          }
        }
      } else {
        warning = warning ?
          `${warning}; Could not remove image because repository information is not available` :
          'Could not remove image because repository information is not available';
      }

      // Move template to removed directory (only if it exists)
      if (templateExists) {
        await fs.rename(templatePath, removedPath);
      }

      // Remove container entry from containers file and reindex
      try {
        const containersFilePath = '/var/lib/docker/mos/containers';

        // Check if containers file exists
        try {
          await fs.access(containersFilePath);
        } catch (err) {
          if (err.code === 'ENOENT') {
            // File doesn't exist, skip container list update
            return {
              success: true,
              message: `Container '${name}' and its template have been removed`,
              warning: warning
            };
          }
          throw err;
        }

        // Read containers file
        const containersData = await fs.readFile(containersFilePath, 'utf8');
        let containers = JSON.parse(containersData);

        // Remove the container with the specified name
        const originalLength = containers.length;
        containers = containers.filter(container => container.name !== name);

        // Only proceed if a container was actually removed
        if (containers.length < originalLength) {
          // Sort containers by current index to maintain order
          containers.sort((a, b) => (a.index || 0) - (b.index || 0));

          // Reindex starting from 1
          containers.forEach((container, index) => {
            container.index = index + 1;
          });

          // Write the updated containers list back to file
          await fs.writeFile(containersFilePath, JSON.stringify(containers, null, 2), 'utf8');
        }
      } catch (containerFileError) {
        // If updating the containers file fails, log the warning but don't fail the removal
        warning = warning ?
          `${warning}; Failed to update containers file: ${containerFileError.message}` :
          `Failed to update containers file: ${containerFileError.message}`;
      }

      return {
        success: true,
        message: `Container '${name}' and its template have been removed`,
        warning: warning
      };
    } catch (error) {
      throw new Error(`Container removal failed: ${error.message}`);
    }
  }

  /**
   * Converts XML using the MOS XML convert script
   * @param {string} url - The URL to convert
   * @returns {Promise<Object>} Result of the conversion process
   */
  async convertXml(url) {
    try {
      // Path to XML convert script
      const scriptPath = '/usr/local/bin/mos-xml_convert';

      // Check if URL is provided
      if (!url) {
        throw new Error('URL is required');
      }

      // Command with URL parameter
      const command = `${scriptPath} ${url}`;

      // Execute command
      const { stdout, stderr } = await execPromise(command);

      if (stderr) {
        throw new Error(`Error executing XML conversion: ${stderr}`);
      }

      // Try to parse the output as JSON, if possible
      let result;
      try {
        result = JSON.parse(stdout);
      } catch (parseError) {
        // If no JSON output, return text
        return { message: stdout.trim() };
      }

      // Check if name field is null, which indicates an error
      if (result.name === null) {
        throw new Error('Invalid or malformed XML data');
      }

      // If conversion was successful and result has a name, check if template already exists
      if (result.name) {
        const templateExistsPath = path.join('/boot/config/system/docker/templates', `${result.name}.json`);
        try {
          await fs.access(templateExistsPath);
          // Template exists, so append _new to avoid conflicts
          result.name = result.name + '_new';
        } catch (accessError) {
          // Template doesn't exist, keep original name
        }
      }

      return result;
    } catch (error) {
      throw new Error(`Failed to convert XML: ${error.message}`);
    }
  }

  /**
   * Gets a list of removed container templates
   * @returns {Promise<Array>} Array of removed template names
   */
  async getRemovedTemplates() {
    try {
      const removedDir = '/boot/config/system/docker/removed';

      // Check if removed directory exists
      try {
        await fs.access(removedDir);
      } catch (err) {
        if (err.code === 'ENOENT') {
          return []; // Directory doesn't exist, return empty array
        }
        throw err;
      }

      // Read directory contents
      const files = await fs.readdir(removedDir);

      // Filter for .json files and remove the extension
      const templates = files
        .filter(file => file.endsWith('.json'))
        .map(file => ({
          name: file.replace('.json', ''),
          filename: file,
          removed_at: null // Could be enhanced with file stats if needed
        }));

      // Optionally get file stats for removal date
      for (const template of templates) {
        try {
          const filePath = path.join(removedDir, template.filename);
          const stats = await fs.stat(filePath);
          template.removed_at = stats.mtime; // Modification time as removal date
        } catch (statError) {
          // If we can't get stats, continue without the date
        }
      }

      return templates;
    } catch (error) {
      throw new Error(`Failed to get removed templates: ${error.message}`);
    }
  }

  /**
   * Gets a specific removed container template
   * @param {string} name - The name of the removed template
   * @returns {Promise<Object>} The template content
   */
  async getRemovedTemplate(name) {
    try {
      if (!name) {
        throw new Error('Template name is required');
      }

      const removedDir = '/boot/config/system/docker/removed';
      const fileName = `${name}.json`;
      const filePath = path.join(removedDir, fileName);

      // Check if file exists
      try {
        await fs.access(filePath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new Error(`Removed template '${name}' not found`);
        }
        throw err;
      }

      // Read and parse the template file
      const templateData = await fs.readFile(filePath, 'utf8');
      const template = JSON.parse(templateData);

      // Get file stats for additional metadata
      const stats = await fs.stat(filePath);

      return {
        name: name,
        template: template,
        removed_at: stats.mtime,
        file_size: stats.size
      };
    } catch (error) {
      throw new Error(`Failed to get removed template: ${error.message}`);
    }
  }

  /**
   * Gets a list of installed container templates
   * @returns {Promise<Array>} Array of installed template names
   */
  async getInstalledTemplates() {
    try {
      const templatesDir = '/boot/config/system/docker/templates';

      // Check if templates directory exists
      try {
        await fs.access(templatesDir);
      } catch (err) {
        if (err.code === 'ENOENT') {
          return []; // Directory doesn't exist, return empty array
        }
        throw err;
      }

      // Read directory contents
      const files = await fs.readdir(templatesDir);

      // Filter for .json files and remove the extension
      const templates = files
        .filter(file => file.endsWith('.json'))
        .map(file => ({
          name: file.replace('.json', ''),
          filename: file,
          created_at: null // Will be populated with file stats
        }));

      // Get file stats for creation date
      for (const template of templates) {
        try {
          const filePath = path.join(templatesDir, template.filename);
          const stats = await fs.stat(filePath);
          template.created_at = stats.ctime; // Creation time
        } catch (statError) {
          // If we can't get stats, continue without the date
        }
      }

      return templates;
    } catch (error) {
      throw new Error(`Failed to get installed templates: ${error.message}`);
    }
  }

  /**
   * Gets a specific installed container template
   * @param {string} name - The name of the installed template
   * @returns {Promise<Object>} The template content
   */
  async getInstalledTemplate(name) {
    try {
      if (!name) {
        throw new Error('Template name is required');
      }

      const templatesDir = '/boot/config/system/docker/templates';
      const fileName = `${name}.json`;
      const filePath = path.join(templatesDir, fileName);

      // Check if file exists
      try {
        await fs.access(filePath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new Error(`Installed template '${name}' not found`);
        }
        throw err;
      }

      // Read and parse the template file
      const templateData = await fs.readFile(filePath, 'utf8');
      const template = JSON.parse(templateData);

      // Get file stats for additional metadata
      const stats = await fs.stat(filePath);

      return {
        name: name,
        template: template,
        created_at: stats.ctime,
        modified_at: stats.mtime,
        file_size: stats.size
      };
    } catch (error) {
      throw new Error(`Failed to get installed template: ${error.message}`);
    }
  }

  /**
   * Gets a specific template by name, preferring installed over removed
   * @param {string} name - The name of the template
   * @param {boolean} edit - If false, appends '_new' to the template name (default: false)
   * @returns {Promise<Object>} The template object only
   */
  async getTemplate(name, edit = false) {
    try {
      if (!name) {
        throw new Error('Template name is required');
      }

      // First try to get installed template
      try {
        const installedTemplate = await this.getInstalledTemplate(name);
        const template = { ...installedTemplate.template };

        // If edit is false (default), append '_new' to the template name only if a template with that name exists in installed
        if (!edit && template.name) {
          const templateExistsPath = path.join('/boot/config/system/docker/templates', `${template.name}.json`);
          try {
            await fs.access(templateExistsPath);
            // Template exists, so append _new
            template.name = template.name + '_new';
          } catch (accessError) {
            // Template doesn't exist, keep original name
          }
        }

        return template;
      } catch (installedError) {
        // If installed template not found, try removed template
        if (installedError.message.includes('not found')) {
          try {
            const removedTemplate = await this.getRemovedTemplate(name);
            const template = { ...removedTemplate.template };

            // If edit is false (default), append '_new' to the template name only if a template with that name exists in installed
            if (!edit && template.name) {
              const templateExistsPath = path.join('/boot/config/system/docker/templates', `${template.name}.json`);
              try {
                await fs.access(templateExistsPath);
                // Template exists, so append _new
                template.name = template.name + '_new';
              } catch (accessError) {
                // Template doesn't exist, keep original name
              }
            }

            return template;
          } catch (removedError) {
            if (removedError.message.includes('not found')) {
              throw new Error(`Template '${name}' not found in installed or removed templates`);
            }
            throw removedError;
          }
        }
        throw installedError;
      }
    } catch (error) {
      throw new Error(`Failed to get template: ${error.message}`);
    }
  }

  /**
   * Gets all container template names grouped by installed and removed
   * @returns {Promise<Object>} Object containing installed and removed template names
   */
  async getAllTemplates() {
    try {
      const [installedTemplates, removedTemplates] = await Promise.all([
        this.getInstalledTemplates(),
        this.getRemovedTemplates()
      ]);

      // Extract just the names and sort them
      const installedNames = installedTemplates.map(t => t.name).sort();
      const removedNames = removedTemplates.map(t => t.name).sort();

      return {
        installed: installedNames,
        removed: removedNames
      };
    } catch (error) {
      throw new Error(`Failed to get all templates: ${error.message}`);
    }
  }

  /**
   * Get the groups file path
   * @returns {string} Path to groups file
   */
  _getGroupsFilePath() {
    return '/var/lib/docker/mos/groups';
  }

  /**
   * Ensure groups directory exists
   */
  async _ensureGroupsDirectory() {
    const groupsDir = path.dirname(this._getGroupsFilePath());
    try {
      await fs.access(groupsDir);
    } catch (error) {
      await fs.mkdir(groupsDir, { recursive: true });
    }
  }

  /**
   * Read groups from file
   * @returns {Promise<Array>} Array of groups
   */
  async _readGroups() {
    try {
      await this._ensureGroupsDirectory();
      const groupsData = await fs.readFile(this._getGroupsFilePath(), 'utf8');
      return JSON.parse(groupsData);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return []; // File doesn't exist, return empty array
      }
      throw new Error(`Failed to read groups: ${error.message}`);
    }
  }

  /**
   * Write groups to file
   * @param {Array} groups - Array of groups to write
   */
  async _writeGroups(groups) {
    try {
      await this._ensureGroupsDirectory();
      await fs.writeFile(this._getGroupsFilePath(), JSON.stringify(groups, null, 2));
    } catch (error) {
      throw new Error(`Failed to write groups: ${error.message}`);
    }
  }

  /**
   * Generate timestamp-based ID
   * @returns {string} Timestamp ID with nanoseconds
   */
  _generateTimestampId() {
    const now = process.hrtime.bigint();
    return now.toString();
  }

  /**
   * Get running container names from Docker
   * @returns {Promise<Set>} Set of running container names
   */
  async _getRunningContainers() {
    try {
      const { stdout } = await execPromise('docker ps --format "{{.Names}}" --filter "status=running"');
      const runningNames = stdout.trim().split('\n').filter(name => name.length > 0);
      return new Set(runningNames);
    } catch (error) {
      // If docker command fails, return empty set (no running containers)
      return new Set();
    }
  }

  /**
   * Get all container groups
   * @returns {Promise<Array>} Array of groups with their containers
   */
  async getContainerGroups() {
    try {
      const groups = await this._readGroups();

      // Get current container order from containers file
      const containers = await this.getDockerImages();

      // Get running containers ONCE for all groups (performance optimization)
      const runningContainers = await this._getRunningContainers();

      // Enrich groups with current container status and sort by index
      const enrichedGroups = groups.map(group => {
        const filteredContainers = group.containers.filter(containerName =>
          containers.some(c => c.name === containerName)
        );

        // Count running containers in this group (O(1) lookup per container)
        const runningCount = filteredContainers.filter(containerName =>
          runningContainers.has(containerName)
        ).length;

        return {
          ...group,
          containers: filteredContainers,
          count: filteredContainers.length,
          runningCount: runningCount
        };
      }).sort((a, b) => a.index - b.index);

      return enrichedGroups;
    } catch (error) {
      throw new Error(`Failed to get container groups: ${error.message}`);
    }
  }

  /**
   * Check if containers are already assigned to other groups
   * @param {Array} containers - Array of container names to check
   * @param {string} excludeGroupId - Group ID to exclude from check (for updates)
   * @returns {Promise<Array>} Array of conflicts: [{container, groupName, groupId}]
   */
  async _checkContainerConflicts(containers, excludeGroupId = null) {
    const groups = await this._readGroups();
    const conflicts = [];

    for (const container of containers) {
      for (const group of groups) {
        if (group.id === excludeGroupId) continue; // Skip current group when updating

        if (group.containers.includes(container)) {
          conflicts.push({
            container,
            groupName: group.name,
            groupId: group.id
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Create a new container group
   * @param {string} name - Group name
   * @param {Array} containers - Array of container names
   * @returns {Promise<Object>} Created group
   */
  async createContainerGroup(name, containers = []) {
    try {
      if (!name || typeof name !== 'string') {
        throw new Error('Group name is required and must be a string');
      }

      const groups = await this._readGroups();

      // Check if group name already exists
      if (groups.some(group => group.name === name)) {
        throw new Error(`Group with name '${name}' already exists`);
      }

      // Validate containers exist
      const existingContainers = await this.getDockerImages();
      const existingContainerNames = existingContainers.map(c => c.name);

      const invalidContainers = containers.filter(containerName =>
        !existingContainerNames.includes(containerName)
      );

      if (invalidContainers.length > 0) {
        throw new Error(`Containers not found: ${invalidContainers.join(', ')}`);
      }

      // Check for container conflicts (containers already in other groups)
      const conflicts = await this._checkContainerConflicts(containers);
      if (conflicts.length > 0) {
        const conflictMessages = conflicts.map(c =>
          `'${c.container}' is already in group '${c.groupName}'`
        );
        throw new Error(`Container conflicts: ${conflictMessages.join(', ')}`);
      }

      // Get next index
      const nextIndex = groups.length > 0 ? Math.max(...groups.map(g => g.index)) + 1 : 1;

      const newGroup = {
        id: this._generateTimestampId(),
        name,
        index: nextIndex,
        containers: [...new Set(containers)], // Remove duplicates
        icon: null
      };

      groups.push(newGroup);
      await this._writeGroups(groups);

      return newGroup;
    } catch (error) {
      throw new Error(`Failed to create container group: ${error.message}`);
    }
  }

  /**
   * Delete a container group
   * @param {string} groupId - Group ID to delete
   * @returns {Promise<boolean>} True if deleted successfully
   */
  async deleteContainerGroup(groupId) {
    try {
      const groups = await this._readGroups();
      const groupIndex = groups.findIndex(group => group.id === groupId);

      if (groupIndex === -1) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      groups.splice(groupIndex, 1);
      await this._writeGroups(groups);

      return true;
    } catch (error) {
      throw new Error(`Failed to delete container group: ${error.message}`);
    }
  }

  /**
   * Start all containers in a group
   * @param {string} groupId - Group ID
   * @returns {Promise<Object>} Result with success/failure details
   */
  async startContainerGroup(groupId) {
    try {
      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      const results = {
        groupId,
        groupName: group.name,
        totalContainers: group.containers.length,
        results: [],
        successCount: 0,
        failureCount: 0
      };

      // Start each container in the group
      for (const containerName of group.containers) {
        try {
          await execPromise(`docker start ${containerName}`);
          results.results.push({
            container: containerName,
            status: 'success',
            message: 'Container started successfully'
          });
          results.successCount++;
        } catch (error) {
          results.results.push({
            container: containerName,
            status: 'error',
            message: error.message
          });
          results.failureCount++;
        }
      }

      return results;
    } catch (error) {
      throw new Error(`Failed to start container group: ${error.message}`);
    }
  }

  /**
   * Stop all containers in a group (parallel execution)
   * @param {string} groupId - Group ID
   * @returns {Promise<Object>} Result with success/failure details
   */
  async stopContainerGroup(groupId) {
    try {
      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      const results = {
        groupId,
        groupName: group.name,
        totalContainers: group.containers.length,
        results: [],
        successCount: 0,
        failureCount: 0
      };

      // Stop all containers in parallel using Promise.allSettled
      const stopPromises = group.containers.map(async (containerName) => {
        try {
          await execPromise(`docker stop ${containerName}`);
          return {
            container: containerName,
            status: 'success',
            message: 'Container stopped successfully'
          };
        } catch (error) {
          return {
            container: containerName,
            status: 'error',
            message: error.message
          };
        }
      });

      // Wait for all stop operations to complete (parallel)
      const stopResults = await Promise.allSettled(stopPromises);

      // Process results
      stopResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          results.results.push(result.value);
          if (result.value.status === 'success') {
            results.successCount++;
          } else {
            results.failureCount++;
          }
        } else {
          // This should not happen since we catch errors in the promise
          results.results.push({
            container: 'unknown',
            status: 'error',
            message: result.reason?.message || 'Unknown error'
          });
          results.failureCount++;
        }
      });

      return results;
    } catch (error) {
      throw new Error(`Failed to stop container group: ${error.message}`);
    }
  }

  /**
   * Add containers to a group
   * @param {string} groupId - Group ID
   * @param {Array} containerNames - Array of container names to add
   * @returns {Promise<Object>} Updated group
   */
  async addContainersToGroup(groupId, containerNames) {
    try {
      if (!Array.isArray(containerNames) || containerNames.length === 0) {
        throw new Error('Container names must be a non-empty array');
      }

      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      // Validate containers exist
      const existingContainers = await this.getDockerImages();
      const existingContainerNames = existingContainers.map(c => c.name);

      const invalidContainers = containerNames.filter(containerName =>
        !existingContainerNames.includes(containerName)
      );

      if (invalidContainers.length > 0) {
        throw new Error(`Containers not found: ${invalidContainers.join(', ')}`);
      }

      // Add containers (avoid duplicates)
      containerNames.forEach(containerName => {
        if (!group.containers.includes(containerName)) {
          group.containers.push(containerName);
        }
      });

      await this._writeGroups(groups);
      return group;
    } catch (error) {
      throw new Error(`Failed to add containers to group: ${error.message}`);
    }
  }

  /**
   * Remove containers from a group
   * @param {string} groupId - Group ID
   * @param {Array} containerNames - Array of container names to remove
   * @returns {Promise<Object>} Updated group
   */
  async removeContainersFromGroup(groupId, containerNames) {
    try {
      if (!Array.isArray(containerNames) || containerNames.length === 0) {
        throw new Error('Container names must be a non-empty array');
      }

      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID '${groupId}' not found`);
      }

      // Remove containers
      group.containers = group.containers.filter(containerName =>
        !containerNames.includes(containerName)
      );

      await this._writeGroups(groups);
      return group;
    } catch (error) {
      throw new Error(`Failed to remove containers from group: ${error.message}`);
    }
  }

  /**
   * Update group with partial data (name, icon, containers, etc.)
   * @param {string} groupId - Group ID
   * @param {Object} updateData - Data to update
   * @param {string} [updateData.name] - New group name
   * @param {string|null} [updateData.icon] - New icon (can be null to remove icon)
   * @param {Array} [updateData.containers] - New containers array (replaces existing)
   * @param {Array} [updateData.addContainers] - Containers to add to existing
   * @param {Array} [updateData.removeContainers] - Containers to remove from existing
   * @returns {Promise<Object>} Updated group
   */
  async updateGroup(groupId, updateData) {
    try {
      const groups = await this._readGroups();
      const group = groups.find(g => g.id === groupId);

      if (!group) {
        throw new Error(`Group with ID ${groupId} not found`);
      }

      // Update name if provided
      if (updateData.name !== undefined) {
        if (!updateData.name || typeof updateData.name !== 'string') {
          throw new Error('Group name must be a non-empty string');
        }

        // Check if name already exists (excluding current group)
        const existingGroup = groups.find(g => g.name === updateData.name && g.id !== groupId);
        if (existingGroup) {
          throw new Error(`Group with name '${updateData.name}' already exists`);
        }

        group.name = updateData.name;
      }

      // Update icon if provided
      if (updateData.icon !== undefined) {
        // Allow null or string values for icon
        if (updateData.icon !== null && typeof updateData.icon !== 'string') {
          throw new Error('Icon must be a string or null');
        }
        group.icon = updateData.icon;
      }

      // Handle containers updates
      if (updateData.containers !== undefined) {
        // Replace entire containers array
        if (!Array.isArray(updateData.containers)) {
          throw new Error('Containers must be an array');
        }

        // Validate containers exist
        const allContainers = await this.getDockerImages();
        const containerNames = allContainers.map(c => c.name);
        const invalidContainers = updateData.containers.filter(name => !containerNames.includes(name));

        if (invalidContainers.length > 0) {
          throw new Error(`Invalid containers: ${invalidContainers.join(', ')}`);
        }

        // Check for container conflicts (exclude current group)
        const conflicts = await this._checkContainerConflicts(updateData.containers, groupId);
        if (conflicts.length > 0) {
          const conflictMessages = conflicts.map(c =>
            `'${c.container}' is already in group '${c.groupName}'`
          );
          throw new Error(`Container conflicts: ${conflictMessages.join(', ')}`);
        }

        group.containers = [...new Set(updateData.containers)]; // Remove duplicates
      } else {
        // Handle add/remove operations
        if (updateData.addContainers && Array.isArray(updateData.addContainers)) {
          // Validate containers exist
          const allContainers = await this.getDockerImages();
          const containerNames = allContainers.map(c => c.name);
          const invalidContainers = updateData.addContainers.filter(name => !containerNames.includes(name));

          if (invalidContainers.length > 0) {
            throw new Error(`Invalid containers to add: ${invalidContainers.join(', ')}`);
          }

          // Check for container conflicts for containers to add (exclude current group)
          const conflicts = await this._checkContainerConflicts(updateData.addContainers, groupId);
          if (conflicts.length > 0) {
            const conflictMessages = conflicts.map(c =>
              `'${c.container}' is already in group '${c.groupName}'`
            );
            throw new Error(`Container conflicts: ${conflictMessages.join(', ')}`);
          }

          // Add containers (avoid duplicates)
          const currentContainers = new Set(group.containers);
          updateData.addContainers.forEach(container => currentContainers.add(container));
          group.containers = Array.from(currentContainers);
        }

        if (updateData.removeContainers && Array.isArray(updateData.removeContainers)) {
          // Remove containers
          group.containers = group.containers.filter(container =>
            !updateData.removeContainers.includes(container)
          );
        }
      }

      group.updated_at = new Date().toISOString();

      await this._writeGroups(groups);
      return group;
    } catch (error) {
      throw new Error(`Failed to update group: ${error.message}`);
    }
  }

  /**
   * Update group name
   * @param {string} groupId - Group ID
   * @param {string} newName - New group name
   * @returns {Promise<Object>} Updated group
   * @deprecated Use updateGroup() instead
   */
  async updateGroupName(groupId, newName) {
    return this.updateGroup(groupId, { name: newName });
  }

  /**
   * Update group icon
   * @param {string} groupId - Group ID
   * @param {string|null} icon - New icon (can be null to remove icon)
   * @returns {Promise<Object>} Updated group
   * @deprecated Use updateGroup() instead
   */
  async updateGroupIcon(groupId, icon) {
    return this.updateGroup(groupId, { icon: icon });
  }

  /**
   * Update group order/index
   * @param {Array} groupOrder - Array of group objects with id and index
   * @returns {Promise<Array>} Updated groups array
   */
  async updateGroupOrder(groupOrder) {
    try {
      if (!Array.isArray(groupOrder)) {
        throw new Error('Group order must be an array');
      }

      const groups = await this._readGroups();

      // Validate all group IDs exist
      const groupIds = groups.map(g => g.id);
      const invalidIds = groupOrder.filter(item => !groupIds.includes(item.id));

      if (invalidIds.length > 0) {
        throw new Error(`Invalid group IDs: ${invalidIds.map(item => item.id).join(', ')}`);
      }

      // Update indices
      groupOrder.forEach(orderItem => {
        const group = groups.find(g => g.id === orderItem.id);
        if (group) {
          group.index = orderItem.index;
        }
      });

      await this._writeGroups(groups);

      // Return sorted groups
      return groups.sort((a, b) => a.index - b.index);
    } catch (error) {
      throw new Error(`Failed to update group order: ${error.message}`);
    }
  }
}

module.exports = new DockerService();
