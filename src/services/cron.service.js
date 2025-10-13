const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class CronService {
  constructor() {
    this.cronFile = '/boot/config/system/cron.json';
  }

  /**
   * Erstellt das Verzeichnis falls es nicht existiert
   * @private
   */
  async _ensureDirectoryExists() {
    const dir = path.dirname(this.cronFile);
    try {
      await fs.access(dir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.mkdir(dir, { recursive: true });
      } else {
        throw error;
      }
    }
  }

  /**
   * Reads all cron jobs from the JSON file
   * @returns {Promise<Array>} Array of cron jobs
   */
  async getCronJobs() {
    try {
      await this._ensureDirectoryExists();
      const data = await fs.readFile(this.cronFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File does not exist - return empty array
        return [];
      }
      throw new Error(`Error reading cron.json: ${error.message}`);
    }
  }

  /**
   * Saves all cron jobs to the JSON file
   * @param {Array} cronJobs - Array of cron jobs
   * @private
   */
  async _saveCronJobs(cronJobs) {
    await this._ensureDirectoryExists();
    await fs.writeFile(this.cronFile, JSON.stringify(cronJobs, null, 2), 'utf8');
  }

  /**
   * Generates a unique ID for a new cron job
   * @param {Array} existingJobs - Existing cron jobs
   * @returns {string} Unique ID
   * @private
   */
  _generateUniqueId(existingJobs) {
    let id;
    do {
      id = Date.now().toString();
      // Small delay to ensure unique IDs
      // in case multiple jobs are created quickly
    } while (existingJobs.find(job => job.id === id));
    return id;
  }

  /**
   * Converts a cron job name to a safe filename
   * @param {string} name - Cron job name
   * @returns {string} Safe filename
   * @private
   */
  _generateSafeFilename(name) {
    // Replace spaces and special characters with underscores
    // Remove dangerous characters for filesystem
    return name
      .replace(/[^a-zA-Z0-9\s\-_]/g, '_')  // Replace all non-alphanumeric characters except spaces, hyphens, and underscores
      .replace(/\s+/g, '_')                 // Replace spaces with underscores
      .replace(/_+/g, '_')                  // Merge multiple consecutive underscores
      .replace(/^_+|_+$/g, '')             // Remove leading and trailing underscores
      .toLowerCase();                       // Convert to lowercase
  }

  /**
   * Creates a script for a cron job
   * @param {string} name - Cron job name
   * @param {string} scriptContent - Script content
   * @param {boolean} convertToUnix - Whether to convert the script to Unix format using dos2unix (default: false)
   * @returns {Promise<string>} Path to the created script
   * @private
   */
  async _createCronScript(name, scriptContent, convertToUnix = false) {
    try {
      const scriptsDir = '/boot/optional/scripts/cron';

      // Check if directory exists, create it if not
      try {
        await fs.access(scriptsDir);
      } catch (error) {
        if (error.code === 'ENOENT') {
          await fs.mkdir(scriptsDir, { recursive: true });
        } else {
          throw error;
        }
      }

      // Generate safe filename
      const safeFilename = this._generateSafeFilename(name);
      const scriptPath = path.join(scriptsDir, `${safeFilename}.sh`);

      // Create script content with shebang
      const fullScriptContent = `${scriptContent}`;

      // Create script and make it executable
      await fs.writeFile(scriptPath, fullScriptContent, 'utf8');
      await execPromise(`chmod +x "${scriptPath}"`);

      // Convert to Unix format if requested
      if (convertToUnix) {
        try {
          await execPromise(`dos2unix "${scriptPath}"`);
        } catch (error) {
          console.warn(`Warning: dos2unix conversion failed for ${scriptPath}: ${error.message}`);
        }
      }

      return scriptPath;
    } catch (error) {
      throw new Error(`Error creating cron script: ${error.message}`);
    }
  }

  /**
   * Validates a cron job
   * @param {Object} jobData - Cron job data
   * @param {boolean} isUpdate - Whether it is an update
   * @private
   */
  _validateCronJob(jobData, isUpdate = false) {
    if (!isUpdate || jobData.name !== undefined) {
      if (!jobData.name || typeof jobData.name !== 'string') {
        throw new Error('Name is required and must be a string');
      }
    }

    if (!isUpdate || jobData.schedule !== undefined) {
      if (!jobData.schedule || typeof jobData.schedule !== 'string') {
        throw new Error('Schedule is required and must be a string');
      }

      const schedule = jobData.schedule.trim();

      // Check for special cron shortcuts
      const validShortcuts = ['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'];
      const isShortcut = validShortcuts.includes(schedule);

      if (!isShortcut) {
        // Default Cron-Format validation (5 fields)
        const cronParts = schedule.split(/\s+/);
        if (cronParts.length !== 5) {
          throw new Error('Schedule must be in Cron format (5 fields: Minute Hour Day Month Weekday) or a valid shortcut (@reboot, @daily, @hourly, etc.)');
        }
      }
    }

    // Either command, script, or scriptPath is required
    if (!isUpdate || jobData.command !== undefined || jobData.script !== undefined || jobData.scriptPath !== undefined) {
      const hasScript = jobData.script && typeof jobData.script === 'string' && jobData.script.trim() !== '';
      const hasScriptPath = jobData.scriptPath && typeof jobData.scriptPath === 'string' && jobData.scriptPath.trim() !== '';
      const hasCommand = jobData.command && typeof jobData.command === 'string' && jobData.command.trim() !== '';

      // At least one of command, script, or scriptPath must be provided
      if (!hasScript && !hasScriptPath && !hasCommand) {
        throw new Error('Either command, script, or scriptPath must be provided');
      }

      // Validate types if provided
      if (jobData.script !== undefined && typeof jobData.script !== 'string') {
        throw new Error('Script must be a string');
      }

      if (jobData.scriptPath !== undefined && typeof jobData.scriptPath !== 'string') {
        throw new Error('ScriptPath must be a string');
      }

      if (jobData.command !== undefined && typeof jobData.command !== 'string') {
        throw new Error('Command must be a string');
      }
    }

    if (jobData.enabled !== undefined) {
      if (typeof jobData.enabled !== 'boolean') {
        throw new Error('Enabled must be a boolean value');
      }
    }

    // Check that either script or scriptPath is specified, but not both
    if (jobData.script && jobData.scriptPath) {
      throw new Error('Cannot specify both script content and scriptPath. Use either script to create a new script or scriptPath to reference an existing script.');
    }

    // Validate convert_to_unix if provided
    if (jobData.convert_to_unix !== undefined && typeof jobData.convert_to_unix !== 'boolean') {
      throw new Error('convert_to_unix must be a boolean value');
    }
  }

  /**
   * Creates a new cron job
   * @param {Object} jobData - Cron job data {name, schedule, command, script?, scriptPath?, enabled?, convert_to_unix?}
   * @returns {Promise<Object>} Created cron job
   */
  async createCronJob(jobData) {
    try {
      this._validateCronJob(jobData);

      const cronJobs = await this.getCronJobs();

      // Check if name already exists
      const existingJob = cronJobs.find(job => job.name === jobData.name);
      if (existingJob) {
        throw new Error(`A Cron-Job with the name "${jobData.name}" already exists`);
      }

      let scriptPath = null;
      let finalCommand = jobData.command || null;

      // If script content is provided, create the script
      if (jobData.script) {
        const convertToUnix = jobData.convert_to_unix || false;
        scriptPath = await this._createCronScript(jobData.name, jobData.script, convertToUnix);
        // Set the command to the created script with output suppression
        finalCommand = `bash ${scriptPath} > /dev/null 2>&1`;
      }

      // If scriptPath is provided, use it
      if (jobData.scriptPath) {
        scriptPath = jobData.scriptPath;
        // Check if the script exists
        try {
          await fs.access(scriptPath);
        } catch (error) {
          throw new Error(`Referenced script does not exist: ${scriptPath}`);
        }
        // Set the command to the referenced script with output suppression
        finalCommand = `bash ${scriptPath} > /dev/null 2>&1`;
      }

      // Ensure we have a command at this point
      if (!finalCommand) {
        throw new Error('No command could be determined. Provide either command, script, or scriptPath.');
      }

      // Create new job
      const newJob = {
        id: this._generateUniqueId(cronJobs),
        name: jobData.name,
        schedule: jobData.schedule,
        command: finalCommand,
        enabled: jobData.enabled !== undefined ? jobData.enabled : true,
        scriptPath: scriptPath
      };

      cronJobs.push(newJob);
      await this._saveCronJobs(cronJobs);

      // Cron-Konfiguration aktualisieren
      await execPromise('/usr/local/bin/mos-cron_update');

      return newJob;
    } catch (error) {
      throw new Error(`Error creating Cron-Job: ${error.message}`);
    }
  }

  /**
   * Sucht einen Cron-Job nach ID oder Name
   * @param {string} identifier - ID oder Name des Cron-Jobs
   * @returns {Promise<Object>} Gefundener Cron-Job oder null
   */
  async findCronJob(identifier) {
    const cronJobs = await this.getCronJobs();
    return cronJobs.find(job => job.id === identifier || job.name === identifier) || null;
  }

  /**
   * Aktualisiert einen Cron-Job
   * @param {string} identifier - ID oder Name des zu aktualisierenden Jobs
   * @param {Object} updates - Felder die aktualisiert werden sollen
   * @returns {Promise<Object>} Aktualisierter Cron-Job
   */
  async updateCronJob(identifier, updates) {
    try {
      this._validateCronJob(updates, true);

      const cronJobs = await this.getCronJobs();
      const jobIndex = cronJobs.findIndex(job => job.id === identifier || job.name === identifier);

      if (jobIndex === -1) {
        throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
      }

      // Check if new name already exists (if name is changed)
      if (updates.name && updates.name !== cronJobs[jobIndex].name) {
        const existingJob = cronJobs.find(job => job.name === updates.name);
        if (existingJob) {
          throw new Error(`A Cron-Job with the name "${updates.name}" already exists`);
        }
      }

      // Apply updates (only allowed fields)
      const allowedFields = ['name', 'schedule', 'command', 'enabled'];
      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          cronJobs[jobIndex][field] = updates[field];
        }
      }

      // Execute script updates
      if (updates.script || updates.scriptPath) {
        let newScriptPath = null;
        let newCommand = cronJobs[jobIndex].command;

        // If script content is provided, create a new script
        if (updates.script) {
          // Delete old script if it exists
          if (cronJobs[jobIndex].scriptPath) {
            try {
              await fs.unlink(cronJobs[jobIndex].scriptPath);
            } catch (error) {
              console.warn(`Warning: Could not delete old script file ${cronJobs[jobIndex].scriptPath}: ${error.message}`);
            }
          }

          const convertToUnix = updates.convert_to_unix || false;
          newScriptPath = await this._createCronScript(updates.name || cronJobs[jobIndex].name, updates.script, convertToUnix);
          newCommand = `bash ${newScriptPath} > /dev/null 2>&1`;
        }

        // If scriptPath is provided, use it
        if (updates.scriptPath) {
          newScriptPath = updates.scriptPath;
          // Check if the script exists
          try {
            await fs.access(newScriptPath);
          } catch (error) {
            throw new Error(`Referenced script does not exist: ${newScriptPath}`);
          }
          newCommand = `bash ${newScriptPath} > /dev/null 2>&1`;
        }

        cronJobs[jobIndex].scriptPath = newScriptPath;
        cronJobs[jobIndex].command = newCommand;
      }

      await this._saveCronJobs(cronJobs);

      // Update Cron configuration
      await execPromise('/usr/local/bin/mos-cron_update');

      return cronJobs[jobIndex];
    } catch (error) {
      throw new Error(`Error updating Cron-Job: ${error.message}`);
    }
  }

  /**
   * Deletes a Cron-Job
   * @param {string} identifier - ID or name of the job to delete
   * @param {boolean} deleteScript - Whether the associated script should also be deleted (default: false)
   * @returns {Promise<Object>} Deleted Cron-Job
   */
  async deleteCronJob(identifier, deleteScript = false) {
    try {
      const cronJobs = await this.getCronJobs();
      const jobIndex = cronJobs.findIndex(job => job.id === identifier || job.name === identifier);

      if (jobIndex === -1) {
        throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
      }

      const deletedJob = cronJobs[jobIndex];

      // Delete the script if it exists and deleteScript is true
      if (deleteScript && deletedJob.scriptPath) {
        try {
          await fs.unlink(deletedJob.scriptPath);
          console.log(`Script deleted: ${deletedJob.scriptPath}`);
        } catch (error) {
          console.warn(`Warning: Could not delete script file ${deletedJob.scriptPath}: ${error.message}`);
        }
      }

      cronJobs.splice(jobIndex, 1);

      await this._saveCronJobs(cronJobs);

      // Update Cron configuration
      await execPromise('/usr/local/bin/mos-cron_update');

      return deletedJob;
    } catch (error) {
      throw new Error(`Error deleting Cron-Job: ${error.message}`);
    }
  }

  /**
   * Gets a specific Cron-Job by ID or name
   * @param {string} identifier - ID or name of the Cron-Job
   * @returns {Promise<Object>} Cron-Job
   */
  async getCronJob(identifier) {
    const job = await this.findCronJob(identifier);
    if (!job) {
      throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
    }
    return job;
  }

  /**
   * Activates a Cron-Job
   * @param {string} identifier - ID or name of the Cron-Job
   * @returns {Promise<Object>} Activated Cron-Job
   */
  async enableCronJob(identifier) {
    try {
      const cronJobs = await this.getCronJobs();
      const jobIndex = cronJobs.findIndex(job => job.id === identifier || job.name === identifier);

      if (jobIndex === -1) {
        throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
      }

      cronJobs[jobIndex].enabled = true;
      await this._saveCronJobs(cronJobs);

      // Cron configuration updated
      await execPromise('/usr/local/bin/mos-cron_update');

      return cronJobs[jobIndex];
    } catch (error) {
      throw new Error(`Error enabling Cron-Job: ${error.message}`);
    }
  }

  /**
   * Deactivates a Cron-Job
   * @param {string} identifier - ID or name of the Cron-Job
   * @returns {Promise<Object>} Deactivated Cron-Job
   */
  async disableCronJob(identifier) {
    try {
      const cronJobs = await this.getCronJobs();
      const jobIndex = cronJobs.findIndex(job => job.id === identifier || job.name === identifier);

      if (jobIndex === -1) {
        throw new Error(`Cron-Job with ID/Name "${identifier}" not found`);
      }

      cronJobs[jobIndex].enabled = false;
      await this._saveCronJobs(cronJobs);

      // Cron configuration updated
      await execPromise('/usr/local/bin/mos-cron_update');

      return cronJobs[jobIndex];
    } catch (error) {
      throw new Error(`Error disabling Cron-Job: ${error.message}`);
    }
  }

  /**
   * Lists all available scripts in the Cron-Script directory
   * @returns {Promise<Array>} Array of available scripts
   */
  async listCronScripts() {
    try {
      const scriptsDir = '/boot/optional/scripts/cron';

      try {
        await fs.access(scriptsDir);
      } catch (error) {
        if (error.code === 'ENOENT') {
          return [];
        } else {
          throw error;
        }
      }

      const files = await fs.readdir(scriptsDir);
      const scripts = [];

      for (const file of files) {
        if (file.endsWith('.sh')) {
          const filePath = path.join(scriptsDir, file);
          try {
            const stats = await fs.stat(filePath);
            scripts.push({
              name: file,
              path: filePath,
              size: stats.size,
              created: stats.birthtime,
              modified: stats.mtime
            });
          } catch (error) {
            console.warn(`Warning: Could not read file info for ${file}: ${error.message}`);
          }
        }
      }

      return scripts.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      throw new Error(`Error listing cron scripts: ${error.message}`);
    }
  }

  /**
   * Gets the content of a Cron-Script
   * @param {string} scriptName - Name of the script (with or without .sh)
   * @returns {Promise<Object>} Script information and content
   */
  async getCronScript(scriptName) {
    try {
      const scriptsDir = '/boot/optional/scripts/cron';

      // Add .sh if not present
      if (!scriptName.endsWith('.sh')) {
        scriptName = scriptName + '.sh';
      }

      const scriptPath = path.join(scriptsDir, scriptName);

      try {
        await fs.access(scriptPath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`Script '${scriptName}' not found`);
        } else {
          throw error;
        }
      }

      const stats = await fs.stat(scriptPath);
      const content = await fs.readFile(scriptPath, 'utf8');

      return {
        name: scriptName,
        path: scriptPath,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        content: content
      };
    } catch (error) {
      throw new Error(`Error reading cron script: ${error.message}`);
    }
  }

  /**
   * Updates the content of a Cron-Script
   * @param {string} scriptName - Name of the script (with or without .sh)
   * @param {string} newContent - New script content
   * @returns {Promise<Object>} Updated script
   */
  async updateCronScript(scriptName, newContent) {
    try {
      const scriptsDir = '/boot/optional/scripts/cron';

      // Add .sh if not present
      if (!scriptName.endsWith('.sh')) {
        scriptName = scriptName + '.sh';
      }

      const scriptPath = path.join(scriptsDir, scriptName);

      try {
        await fs.access(scriptPath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`Script '${scriptName}' not found`);
        } else {
          throw error;
        }
      }

      // Update script content
      await fs.writeFile(scriptPath, newContent, 'utf8');

      // Make sure the file is executable
      await execPromise(`chmod +x "${scriptPath}"`);

      const stats = await fs.stat(scriptPath);
      const content = await fs.readFile(scriptPath, 'utf8');

      return {
        name: scriptName,
        path: scriptPath,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        content: content
      };
    } catch (error) {
      throw new Error(`Error updating cron script: ${error.message}`);
    }
  }

  /**
   * Deletes a Cron-Script
   * @param {string} scriptName - Name of the script (with or without .sh)
   * @param {boolean} deleteDependentJobs - Whether dependent Cron-Jobs should also be deleted (default: false)
   * @returns {Promise<Object>} Deleted script and deleted jobs
   */
  async deleteCronScript(scriptName, deleteDependentJobs = false) {
    try {
      const scriptsDir = '/boot/optional/scripts/cron';

      // Add .sh if not present
      if (!scriptName.endsWith('.sh')) {
        scriptName = scriptName + '.sh';
      }

      const scriptPath = path.join(scriptsDir, scriptName);

      try {
        await fs.access(scriptPath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error(`Script '${scriptName}' not found`);
        } else {
          throw error;
        }
      }

      // Check if the script is used by a cron job
      const cronJobs = await this.getCronJobs();
      const usedBy = cronJobs.filter(job => job.scriptPath === scriptPath);

      let deletedJobs = [];

      if (usedBy.length > 0) {
        if (deleteDependentJobs) {
          // Delete all dependent cron jobs
          for (const job of usedBy) {
            try {
              await this.deleteCronJob(job.id, false); // Script not deleted, as we delete it separately
              deletedJobs.push(job);
            } catch (error) {
              console.warn(`Warning: Could not delete dependent cron job ${job.name}: ${error.message}`);
            }
          }
        } else {
          const jobNames = usedBy.map(job => job.name).join(', ');
          throw new Error(`Cannot delete script '${scriptName}' - it is used by cron job(s): ${jobNames}. Use deleteDependentJobs=true to also delete dependent jobs.`);
        }
      }

      const stats = await fs.stat(scriptPath);
      const content = await fs.readFile(scriptPath, 'utf8');

      // Delete the file
      await fs.unlink(scriptPath);

      return {
        name: scriptName,
        path: scriptPath,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        content: content,
        deletedJobs: deletedJobs,
        dependentJobsCount: usedBy.length
      };
    } catch (error) {
      throw new Error(`Error deleting cron script: ${error.message}`);
    }
  }
}

module.exports = new CronService(); 