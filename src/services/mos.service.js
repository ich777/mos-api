const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const crypto = require('crypto');
const axios = require('axios');
const PoolsService = require('./pools.service');
const hubService = require('./hub.service');
const systemService = require('./system.service');

class MosService {
  constructor() {
    this.settingsPath = '/boot/config/docker.json';
    this.dashboardPath = '/boot/config/dashboard.json';
    this.sensorsConfigPath = '/boot/config/system/sensors.json';
    this.tokensPath = '/boot/config/system/tokens.json';

    // Sensors config cache
    this._sensorsConfigCache = null;
  }

  // ============================================================
  // SENSOR MAPPING METHODS
  // ============================================================

  /**
   * Generate timestamp-based ID
   * @returns {string} Timestamp ID
   * @private
   */
  _generateSensorId() {
    return Date.now().toString();
  }

  /**
   * Ensure the sensors config directory exists
   * @private
   */
  async _ensureSensorsConfigDir() {
    const dir = path.dirname(this.sensorsConfigPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      // Directory already exists or cannot be created
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Valid sensor types
   * @private
   */
  _getValidSensorTypes() {
    return ['fan', 'temperature', 'power', 'voltage', 'psu', 'other'];
  }

  /**
   * Get empty grouped sensors structure
   * @private
   */
  _getEmptyGroupedSensors() {
    return {
      fan: [],
      temperature: [],
      power: [],
      voltage: [],
      psu: [],
      other: []
    };
  }

  /**
   * Load sensors configuration from file (uses cache if available)
   * @param {boolean} forceReload - Force reload from file, bypassing cache
   * @returns {Promise<Object>} Grouped sensor configurations
   */
  async loadSensorsConfig(forceReload = false) {
    // Return cached config if available
    if (!forceReload && this._sensorsConfigCache) {
      return this._sensorsConfigCache;
    }

    try {
      const data = await fs.readFile(this.sensorsConfigPath, 'utf8');
      const config = JSON.parse(data);

      // Validate it's a grouped object
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        this._sensorsConfigCache = this._getEmptyGroupedSensors();
        return this._sensorsConfigCache;
      }

      // Ensure all groups exist
      const validTypes = this._getValidSensorTypes();
      const result = this._getEmptyGroupedSensors();
      for (const type of validTypes) {
        if (Array.isArray(config[type])) {
          result[type] = config[type];
        }
      }
      this._sensorsConfigCache = result;
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this._sensorsConfigCache = this._getEmptyGroupedSensors();
        return this._sensorsConfigCache;
      }
      throw new Error(`Failed to load sensors config: ${error.message}`);
    }
  }

  /**
   * Save sensors configuration to file (grouped by type)
   * Also updates the in-memory cache
   * @param {Object} groupedSensors - Grouped sensor configurations
   * @private
   */
  async _saveSensorsConfig(groupedSensors) {
    await this._ensureSensorsConfigDir();

    // Re-index sensors within each group
    const validTypes = this._getValidSensorTypes();
    const reindexed = {};
    for (const type of validTypes) {
      if (Array.isArray(groupedSensors[type])) {
        reindexed[type] = groupedSensors[type].map((sensor, idx) => ({
          ...sensor,
          index: idx
        }));
      } else {
        reindexed[type] = [];
      }
    }

    await fs.writeFile(
      this.sensorsConfigPath,
      JSON.stringify(reindexed, null, 2),
      'utf8'
    );

    // Update cache
    this._sensorsConfigCache = reindexed;
    return reindexed;
  }

  /**
   * Invalidate the sensors config cache
   * Call this if the config file was modified externally
   */
  invalidateSensorsCache() {
    this._sensorsConfigCache = null;
  }

  /**
   * Find sensor by source across all groups
   * @param {Object} groupedSensors - Grouped sensor configurations
   * @param {string} source - Source path to find
   * @param {string} excludeId - Optional sensor ID to exclude from search
   * @returns {Object|null} Found sensor with its type, or null
   * @private
   */
  _findSensorBySource(groupedSensors, source, excludeId = null) {
    const validTypes = this._getValidSensorTypes();
    for (const type of validTypes) {
      const sensors = groupedSensors[type] || [];
      const found = sensors.find(s => s.source === source && s.id !== excludeId);
      if (found) {
        return { sensor: found, type };
      }
    }
    return null;
  }

  /**
   * Find sensor by ID across all groups
   * @param {Object} groupedSensors - Grouped sensor configurations
   * @param {string} id - Sensor ID to find
   * @returns {Object|null} Found sensor with its type and index, or null
   * @private
   */
  _findSensorById(groupedSensors, id) {
    const validTypes = this._getValidSensorTypes();
    for (const type of validTypes) {
      const sensors = groupedSensors[type] || [];
      const index = sensors.findIndex(s => s.id === id);
      if (index !== -1) {
        return { sensor: sensors[index], type, index };
      }
    }
    return null;
  }

  /**
   * Get value from nested object using dot notation path
   * Supports escaped dots with \. for keys containing literal dots
   * @param {Object} obj - Source object
   * @param {string} pathStr - Dot notation path (e.g., "adapter.v_out +3\.3v.in3_input")
   * @returns {*} Value at path or undefined
   * @private
   */
  _getValueByPath(obj, pathStr) {
    // Use placeholder for escaped dots, split by unescaped dots, then restore
    const placeholder = '\x00';
    const escaped = pathStr.replace(/\\\./g, placeholder);
    const parts = escaped.split('.').map(p => p.replace(/\x00/g, '.'));

    let current = obj;
    for (const part of parts) {
      if (current === undefined || current === null) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Transform sensor value based on configuration
   * @param {number} value - Raw sensor value
   * @param {Object} sensorConfig - Sensor configuration
   * @returns {number} Transformed value
   * @private
   */
  _transformValue(value, sensorConfig) {
    if (value === undefined || value === null) {
      return null;
    }

    // Apply multiplier first (for voltage dividers etc.)
    if (sensorConfig.multiplier && typeof sensorConfig.multiplier === 'number') {
      value = value * sensorConfig.multiplier;
    }

    // Apply divisor (alternative to multiplier)
    if (sensorConfig.divisor && typeof sensorConfig.divisor === 'number' && sensorConfig.divisor !== 0) {
      value = value / sensorConfig.divisor;
    }

    if (sensorConfig.transform === 'percentage' && sensorConfig.value_range) {
      const { min = 0, max } = sensorConfig.value_range;
      if (max && max !== min) {
        return Math.round(((value - min) / (max - min)) * 100 * 10) / 10;
      }
    }

    // No transformation, return raw value (rounded to 2 decimals)
    return Math.round(value * 100) / 100;
  }

  /**
   * Validate that a sensor source path exists in the raw sensor data
   * @param {string} source - Dot notation path to validate
   * @throws {Error} If source path doesn't exist
   * @private
   */
  async _validateSensorSource(source) {
    let rawSensors;
    try {
      rawSensors = await systemService.getSensors();
    } catch (error) {
      throw new Error(`Cannot validate source: sensors command failed - ${error.message}`);
    }

    const value = this._getValueByPath(rawSensors, source);
    if (value === undefined) {
      throw new Error(`Invalid source: "${source}" not found in sensor data`);
    }
  }

  /**
   * Get sensors configuration (full config, grouped by type)
   * GET /mos/sensors/config
   * @returns {Promise<Object>} Grouped sensors configuration
   */
  async getSensorsConfig() {
    return await this.loadSensorsConfig();
  }

  /**
   * Get mapped sensor values (values only, grouped by type)
   * GET /mos/sensors
   * @returns {Promise<Object>} Grouped sensor values
   */
  async getMappedSensors() {
    const groupedConfig = await this.loadSensorsConfig();
    const validTypes = this._getValidSensorTypes();

    // Check if any sensors exist
    const hasAnySensors = validTypes.some(type => groupedConfig[type]?.length > 0);
    if (!hasAnySensors) {
      return this._getEmptyGroupedSensors();
    }

    // Get raw sensor data
    let rawSensors;
    try {
      rawSensors = await systemService.getSensors();
    } catch (error) {
      console.error('Failed to get raw sensors:', error.message);
      rawSensors = null;
    }

    // Build grouped response with values
    const result = {};
    for (const type of validTypes) {
      const sensors = groupedConfig[type] || [];
      result[type] = sensors
        .filter(s => s.enabled)
        .sort((a, b) => a.index - b.index)
        .map(sensor => {
          let value = null;
          if (rawSensors) {
            const rawValue = this._getValueByPath(rawSensors, sensor.source);
            value = this._transformValue(rawValue, sensor);
          }
          return {
            id: sensor.id,
            index: sensor.index,
            name: sensor.name,
            manufacturer: sensor.manufacturer || null,
            model: sensor.model || null,
            subtype: sensor.subtype || null,
            value: value,
            unit: sensor.unit
          };
        });
    }
    return result;
  }

  /**
   * Get unmapped sensors (available but not yet configured)
   * Returns same structure as /system/sensors but with mapped sources removed
   * GET /mos/sensors/unmapped
   * @returns {Promise<Object>} Sensor data structure with mapped entries removed
   */
  async getUnmappedSensors() {
    // Get current config to find already mapped sources
    const groupedConfig = await this.loadSensorsConfig();
    const validTypes = this._getValidSensorTypes();

    // Collect all mapped sources (unescape \. to . for comparison)
    const mappedSources = new Set();
    for (const type of validTypes) {
      for (const sensor of groupedConfig[type] || []) {
        // Unescape \. to . for comparison with raw sensor paths
        const unescapedSource = sensor.source.replace(/\\\./g, '.');
        mappedSources.add(unescapedSource);
      }
    }

    // Get raw sensor data
    let rawSensors;
    try {
      rawSensors = await systemService.getSensors();
    } catch (error) {
      throw new Error(`Cannot get sensor data: ${error.message}`);
    }

    // Deep clone and filter out mapped sources
    const filterMapped = (obj, path = '') => {
      if (obj === null || obj === undefined) return undefined;
      if (typeof obj !== 'object') return obj;

      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${key}` : key;

        if (typeof value === 'object' && value !== null) {
          // Recurse into nested objects
          const filtered = filterMapped(value, currentPath);
          // Only include if it has remaining properties
          if (filtered && Object.keys(filtered).length > 0) {
            result[key] = filtered;
          }
        } else if (typeof value === 'number') {
          // Check if this sensor value is mapped
          if (!mappedSources.has(currentPath)) {
            result[key] = value;
          }
        } else {
          // Keep non-numeric values (like "Adapter": "ISA adapter")
          result[key] = value;
        }
      }

      return result;
    };

    const unmapped = filterMapped(rawSensors);

    // Remove empty adapter entries (only have "Adapter" string left)
    const cleanEmpty = (obj) => {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null) {
          // Check if this is an adapter with only "Adapter" key left
          const keys = Object.keys(value);
          const hasOnlyAdapter = keys.length === 1 && keys[0] === 'Adapter';
          const isEmpty = keys.length === 0;

          if (!hasOnlyAdapter && !isEmpty) {
            result[key] = value;
          }
        }
      }
      return result;
    };

    return cleanEmpty(unmapped);
  }

  /**
   * Create a new sensor mapping
   * POST /mos/sensors
   * @param {Object} sensorData - Sensor configuration data
   * @returns {Promise<Object>} Created sensor configuration
   */
  async createSensorMapping(sensorData) {
    const groupedSensors = await this.loadSensorsConfig();

    // Validate required fields
    const requiredFields = ['name', 'type', 'source', 'unit'];
    for (const field of requiredFields) {
      if (!sensorData[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Validate type
    const validTypes = this._getValidSensorTypes();
    if (!validTypes.includes(sensorData.type)) {
      throw new Error(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
    }

    // Check for duplicate source
    const existing = this._findSensorBySource(groupedSensors, sensorData.source);
    if (existing) {
      throw new Error(`Source already defined by sensor "${existing.sensor.name}"`);
    }

    // Validate source exists in sensor data
    await this._validateSensorSource(sensorData.source);

    // Validate multiplier/divisor exclusivity
    if (sensorData.multiplier && sensorData.divisor) {
      throw new Error('Cannot specify both multiplier and divisor. Use only one.');
    }

    // Create new sensor config
    const targetGroup = groupedSensors[sensorData.type] || [];
    const newSensor = {
      id: this._generateSensorId(),
      index: targetGroup.length,
      name: sensorData.name,
      manufacturer: sensorData.manufacturer || null,
      model: sensorData.model || null,
      subtype: sensorData.subtype || null,
      source: sensorData.source,
      unit: sensorData.unit,
      multiplier: sensorData.multiplier || null,
      divisor: sensorData.divisor || null,
      value_range: sensorData.value_range || null,
      transform: sensorData.transform || null,
      enabled: sensorData.enabled !== undefined ? sensorData.enabled : true
    };

    // Add to correct group
    groupedSensors[sensorData.type].push(newSensor);
    await this._saveSensorsConfig(groupedSensors);

    return { ...newSensor, type: sensorData.type };
  }

  /**
   * Update an existing sensor mapping
   * POST /mos/sensors/:id
   * @param {string} id - Sensor ID
   * @param {Object} updateData - Fields to update
   * @returns {Promise<Object>} Updated sensor configuration
   */
  async updateSensorMapping(id, updateData) {
    const groupedSensors = await this.loadSensorsConfig();

    // Find sensor
    const found = this._findSensorById(groupedSensors, id);
    if (!found) {
      throw new Error(`Sensor with id ${id} not found`);
    }

    const { sensor, type: currentType, index: currentIndex } = found;

    // Validate type if provided
    const validTypes = this._getValidSensorTypes();
    if (updateData.type && !validTypes.includes(updateData.type)) {
      throw new Error(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
    }

    // Check for duplicate source (excluding this sensor)
    if (updateData.source) {
      const existing = this._findSensorBySource(groupedSensors, updateData.source, id);
      if (existing) {
        throw new Error(`Source already defined by sensor "${existing.sensor.name}"`);
      }
      await this._validateSensorSource(updateData.source);
    }

    // Validate multiplier/divisor exclusivity (check resulting state after update)
    const newMultiplier = updateData.multiplier !== undefined ? updateData.multiplier : sensor.multiplier;
    const newDivisor = updateData.divisor !== undefined ? updateData.divisor : sensor.divisor;
    if (newMultiplier && newDivisor) {
      throw new Error('Cannot specify both multiplier and divisor. Use only one.');
    }

    // Update allowed fields (not type - handled separately)
    const allowedFields = ['name', 'manufacturer', 'model', 'subtype', 'source', 'unit', 'multiplier', 'divisor', 'value_range', 'transform', 'enabled', 'index'];
    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        sensor[field] = updateData[field];
      }
    }

    // Handle type change - move to different group
    const newType = updateData.type || currentType;
    if (newType !== currentType) {
      // Remove from current group
      groupedSensors[currentType].splice(currentIndex, 1);
      // Add to new group
      sensor.index = groupedSensors[newType].length;
      groupedSensors[newType].push(sensor);
    } else if (updateData.index !== undefined && updateData.index !== currentIndex) {
      // Reorder within same group
      groupedSensors[currentType].splice(currentIndex, 1);
      const newIndex = Math.max(0, Math.min(updateData.index, groupedSensors[currentType].length));
      groupedSensors[currentType].splice(newIndex, 0, sensor);
    }

    const savedConfig = await this._saveSensorsConfig(groupedSensors);

    // Find updated sensor in saved config
    const updatedFound = this._findSensorById(savedConfig, id);
    return { ...updatedFound.sensor, type: updatedFound.type };
  }

  /**
   * Delete a sensor mapping
   * DELETE /mos/sensors/:id
   * @param {string} id - Sensor ID
   * @returns {Promise<Object>} Deleted sensor configuration
   */
  async deleteSensorMapping(id) {
    const groupedSensors = await this.loadSensorsConfig();

    // Find sensor
    const found = this._findSensorById(groupedSensors, id);
    if (!found) {
      throw new Error(`Sensor with id ${id} not found`);
    }

    const { sensor, type, index } = found;

    // Remove from group
    groupedSensors[type].splice(index, 1);

    // _saveSensorsConfig automatically re-indexes
    await this._saveSensorsConfig(groupedSensors);

    return { ...sensor, type };
  }

  /**
   * Replace entire sensors configuration
   * PUT /mos/sensors
   * @param {Object} newConfig - New grouped sensor configuration
   * @returns {Promise<Object>} Saved sensor configuration
   */
  async replaceSensorsConfig(newConfig) {
    // Validate input is an object
    if (typeof newConfig !== 'object' || newConfig === null || Array.isArray(newConfig)) {
      throw new Error('Config must be an object with sensor type groups');
    }

    const validTypes = this._getValidSensorTypes();
    const result = this._getEmptyGroupedSensors();

    // Validate and copy each group
    for (const type of validTypes) {
      if (newConfig[type] !== undefined) {
        if (!Array.isArray(newConfig[type])) {
          throw new Error(`Invalid config: ${type} must be an array`);
        }
        // Validate each sensor has required fields
        for (const sensor of newConfig[type]) {
          if (!sensor.id || !sensor.name || !sensor.source || !sensor.unit) {
            throw new Error(`Invalid sensor in ${type}: missing required fields (id, name, source, unit)`);
          }
        }
        result[type] = newConfig[type];
      }
    }

    // Save and return (will re-index)
    return await this._saveSensorsConfig(result);
  }

  /**
   * Finds the first available non-MergerFS pool for default path suggestions
   * Falls back to MergerFS pool if no other pool is available
   * @returns {Promise<string|null>} The pool name or null if no suitable pool found
   */
  async _getFirstNonMergerFSPool() {
    try {
      const baseService = new PoolsService();
      const pools = await baseService.listPools({});

      let firstMergerFSPool = null;

      // First pass: Check for non-MergerFS pools
      for (const pool of pools) {
        if (pool.type !== 'mergerfs') {
          const mountPoint = `/mnt/${pool.name}`;
          const isMounted = await baseService._isMounted(mountPoint);
          if (isMounted) {
            return pool.name;
          }
        } else if (!firstMergerFSPool) {
          // Remember the first MergerFS pool for fallback
          firstMergerFSPool = pool;
        }
      }

      // No non-MergerFS pool found, try to use MergerFS as fallback
      if (firstMergerFSPool) {
        // Find the first available disk in the MergerFS pool
        const firstDisk = await this._getFirstAvailableMergerFSDisk(firstMergerFSPool.name);
        if (firstDisk) {
          return `${firstMergerFSPool.name}/${firstDisk}`;
        }
      }

      return null;
    } catch (error) {
      console.warn('Could not determine default pool for path suggestions:', error.message);
      return null;
    }
  }

  /**
   * Finds the first available disk in a MergerFS pool
   * @param {string} poolName - The MergerFS pool name
   * @returns {Promise<string|null>} The disk name (e.g., 'disk1', 'disk2') or null
   */
  async _getFirstAvailableMergerFSDisk(poolName) {
    try {
      const basePath = `/var/mergerfs/${poolName}`;

      // Check up to 10 disks (should be more than enough)
      for (let i = 1; i <= 10; i++) {
        const diskPath = `${basePath}/disk${i}`;
        try {
          // Check if the disk path exists and is mounted
          const stats = await fs.stat(diskPath);
          if (stats.isDirectory()) {
            // Verify it's actually mounted by checking if it's accessible
            const baseService = new PoolsService();
            const isMounted = await baseService._isMounted(diskPath);
            if (isMounted) {
              return `disk${i}`;
            }
          }
        } catch (err) {
          // Disk doesn't exist or isn't accessible, continue to next
          continue;
        }
      }

      return null;
    } catch (error) {
      console.warn(`Could not determine first available disk for MergerFS pool ${poolName}:`, error.message);
      return null;
    }
  }

  /**
   * Generates default paths for services based on the first available non-MergerFS pool
   * @param {string} poolName - The pool name to use for paths (can be 'poolname' or 'poolname/diskN' for MergerFS)
   * @returns {Object} Default paths for all services
   */
  _generateDefaultPaths(poolName) {
    if (!poolName) return {};

    // Check if this is a MergerFS disk path (contains '/')
    let basePath;
    if (poolName.includes('/')) {
      // MergerFS disk path: poolname/diskN -> /var/mergerfs/poolname/diskN
      basePath = `/var/mergerfs/${poolName}`;
    } else {
      // Regular pool: poolname -> /mnt/poolname
      basePath = `/mnt/${poolName}`;
    }

    return {
      docker: {
        directory: `${basePath}/system/docker`,
        appdata: `${basePath}/appdata`
      },
      lxc: {
        directory: `${basePath}/system/lxc`
      },
      vm: {
        directory: `${basePath}/system/vm`,
        vdisk_directory: `${basePath}/vms`
      }
    };
  }

  /**
   * Checks if a directory path is mounted on a pool
   * @param {string} dirPath - The directory path to check
   * @param {string} serviceType - The service type (docker, lxc, vm) for specific validations
   * @param {string} fieldName - The field name (directory, appdata, vdisk_directory) for specific validations
   * @returns {Promise<Object>} The result of the check
   */
  async _checkDirectoryMountStatus(dirPath, serviceType = null, fieldName = null) {
    try {
      // Normalize the path
      const normalizedPath = path.resolve(dirPath);

      // Check if the path is under /mnt/ (Pool-Mountpoints) or /var/mergerfs/ (MergerFS-Disks)
      const isMntPath = normalizedPath.startsWith('/mnt/');
      const isMergerfsDiskPath = normalizedPath.startsWith('/var/mergerfs/');

      if (!isMntPath && !isMergerfsDiskPath) {
        return {
          isOnPool: false,
          isValid: false,
          error: 'Services can only be configured on Pool-Mountpoints (/mnt/) or MergerFS disks (/var/mergerfs/)',
          suggestion: 'Use a path like /mnt/poolname/service-directory or /var/mergerfs/poolname/disk1/service-directory'
        };
      }

      // Extract Pool name from the path
      const pathParts = normalizedPath.split('/');
      let poolName;
      let poolPath;
      let diskPath = null;

      if (isMergerfsDiskPath) {
        // /var/mergerfs/poolname/disk1/... -> poolname
        if (pathParts.length < 5) {
          return {
            isOnPool: false,
            isValid: false,
            error: 'Invalid MergerFS disk path. Expected format: /var/mergerfs/poolname/diskN/...'
          };
        }
        poolName = pathParts[3]; // /var/mergerfs/poolname/disk1
        diskPath = pathParts[4];  // disk1, disk2, etc.
        poolPath = `/var/mergerfs/${poolName}/${diskPath}`;
      } else {
        // /mnt/poolname/... -> poolname
        if (pathParts.length < 3) {
          return {
            isOnPool: false,
            isValid: false,
            error: 'Invalid Pool Path'
          };
        }
        poolName = pathParts[2];
        poolPath = `/mnt/${poolName}`;
      }

      // Lazy-load PoolsService to avoid circular dependencies
      const baseService = new PoolsService();

      try {
        // Check if Pool exists and status
        // Use listPools() to get real-time mount status instead of static pools.json
        const pools = await baseService.listPools({});
        const pool = pools.find(p => p.name === poolName);

        if (!pool) {
          throw new Error(`Pool "${poolName}" not found`);
        }

        // Check if pool is mergerfs and restrict only core service directories
        // BUT: Allow core directories on individual MergerFS disks (/var/mergerfs/...)
        // Only restrict when using the merged pool mount point (/mnt/poolname)
        const restrictedCombinations = [
          { serviceType: 'docker', fieldName: 'directory' },  // Docker core directory
          { serviceType: 'lxc', fieldName: 'directory' }      // LXC core directory
          // VM directories and Docker appdata are allowed on mergerfs
        ];

        const isRestricted = pool.type === 'mergerfs' &&
          isMntPath && // Only restrict /mnt/ paths, not /var/mergerfs/ disk paths
          restrictedCombinations.some(combo =>
            combo.serviceType === serviceType && combo.fieldName === fieldName
          );

        if (isRestricted) {
          return {
            isOnPool: true,
            isValid: false,
            poolName,
            poolPath,
            userPath: normalizedPath,
            poolType: pool.type,
            error: `${serviceType.toUpperCase()} core directories cannot be placed on MergerFS pool mount points. MergerFS pools are designed for data storage, not for system services.`,
            suggestion: `Use a single or multi device BTRFS, XFS, or EXT4 pool, or use an individual MergerFS disk path like /var/mergerfs/${poolName}/disk1/...`
          };
        }

        // For MergerFS disk paths, verify the specific disk is mounted
        if (isMergerfsDiskPath && diskPath) {
          const diskMountPoint = `/var/mergerfs/${poolName}/${diskPath}`;
          const isDiskMounted = await baseService._isMounted(diskMountPoint);

          if (!isDiskMounted) {
            return {
              isOnPool: true,
              isValid: false,
              poolName,
              poolPath,
              userPath: normalizedPath,
              poolType: pool.type,
              error: `MergerFS disk "${diskPath}" in pool "${poolName}" is not mounted. Service directory would not be available.`,
              suggestion: `Mount the pool "${poolName}" first or choose a different disk.`
            };
          }
        } else {
          // Regular pool mount check
          if (!pool.status.mounted) {
            return {
              isOnPool: true,
              isValid: false,
              poolName,
              poolPath,
              userPath: normalizedPath,
              poolType: pool.type,
              error: `Pool "${poolName}" is not mounted. Service directory would not be available.`,
              suggestion: `Mount the pool "${poolName}" first or choose a different path.`
            };
          }
        }

        return {
          isOnPool: true,
          isValid: true,
          poolName,
          poolPath,
          userPath: normalizedPath,
          poolType: pool.type,
          message: diskPath
            ? `Pool "${poolName}" disk "${diskPath}" (${pool.type}) is mounted - Path is available`
            : `Pool "${poolName}" (${pool.type}) is mounted - Path is available`
        };

      } catch (poolError) {
        if (poolError.message.includes('not found')) {
          return {
            isOnPool: true,
            isValid: false,
            poolName,
            poolPath,
            userPath: normalizedPath,
            error: `Pool "${poolName}" does not exist.`,
            suggestion: 'Create the pool first or choose a different path.'
          };
        }
        throw poolError;
      }

    } catch (error) {
      console.error('Error checking directory mount status:', error.message);
      return {
        isOnPool: false,
        isValid: false,
        error: `Error checking directory mount status: ${error.message}`
      };
    }
  }

  /**
   * Checks multiple directory paths at once
   * @param {Object} pathsToCheck - Object with paths {fieldName: path}
   * @param {string} serviceType - The service type (docker, lxc, vm) for specific validations
   * @returns {Promise<Object>} Summary of the check results
   */
  async _checkMultipleDirectories(pathsToCheck, serviceType = null) {
    const results = {};
    const errors = [];

    for (const [fieldName, dirPath] of Object.entries(pathsToCheck)) {
      if (!dirPath || typeof dirPath !== 'string') {
        continue; // Skip empty/invalid paths
      }

      const check = await this._checkDirectoryMountStatus(dirPath, serviceType, fieldName);
      results[fieldName] = check;

      if (!check.isValid) {
        errors.push({
          field: fieldName,
          path: dirPath,
          error: check.error,
          suggestion: check.suggestion
        });
      }
    }

    return {
      hasErrors: errors.length > 0,
      results,
      errors
    };
  }

  /**
   * Returns the default docker settings structure with all expected fields
   * @returns {Promise<Object>} Default docker settings
   */
  async _getDefaultDockerSettings() {
    const defaultPoolName = await this._getFirstNonMergerFSPool();
    const defaultPaths = defaultPoolName ? this._generateDefaultPaths(defaultPoolName) : null;

    return {
      enabled: false,
      directory: defaultPaths ? defaultPaths.docker.directory : null,
      appdata: defaultPaths ? defaultPaths.docker.appdata : null,
      docker_net: {
        mode: 'macvlan',
        config: []
      },
      filesystem: 'overlay2',
      start_wait: 0,
      docker_options: '',
      update_check: {
        enabled: false,
        update_check_schedule: '0 1 * * *',
        auto_update: {
          enabled: false,
          auto_update_schedule: '0 2 * * SAT'
        }
      }
    };
  }

  /**
   * Reads the Docker settings from the docker.json file.
   * Ensures all expected fields are present by merging with defaults.
   * @returns {Promise<Object>} The Docker settings as an object
   */
  async getDockerSettings() {
    try {
      const defaults = await this._getDefaultDockerSettings();

      let loadedSettings = {};
      try {
        const data = await fs.readFile(this.settingsPath, 'utf8');
        loadedSettings = JSON.parse(data);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.warn('docker.json not found, returning defaults');
          return defaults;
        }
        throw error;
      }

      // Merge loaded settings with defaults (loaded settings take precedence)
      const settings = this._deepMerge(defaults, loadedSettings);

      // Set default paths if values are still null
      if (settings.directory === null || settings.appdata === null) {
        const defaultPoolName = await this._getFirstNonMergerFSPool();
        if (defaultPoolName) {
          const defaultPaths = this._generateDefaultPaths(defaultPoolName);
          if (settings.directory === null) {
            settings.directory = defaultPaths.docker.directory;
          }
          if (settings.appdata === null) {
            settings.appdata = defaultPaths.docker.appdata;
          }
        }
      }

      return settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('docker.json not found');
      }
      throw new Error(`Error reading docker.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the docker.json. Only the passed fields are updated.
   * If enabled is changed, the Docker service is stopped/started.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateDockerSettings(updates) {
    try {
      // Read current settings with defaults
      const defaults = await this._getDefaultDockerSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile(this.settingsPath, 'utf8');
        const loadedSettings = JSON.parse(data);
        // Merge loaded settings with defaults
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Only allowed fields are updated
      const allowed = ['enabled', 'directory', 'appdata', 'docker_net', 'filesystem', 'start_wait', 'docker_options', 'update_check'];
      let updateCheckChanged = false;

      // Check directory paths for mount status
      const pathsToCheck = {};
      if (updates.directory && updates.directory !== current.directory) {
        pathsToCheck.directory = updates.directory;
      }
      if (updates.appdata && updates.appdata !== current.appdata) {
        pathsToCheck.appdata = updates.appdata;
      }

      if (Object.keys(pathsToCheck).length > 0) {
        const directoryCheck = await this._checkMultipleDirectories(pathsToCheck, 'docker');

        if (directoryCheck.hasErrors) {
          const errorDetails = directoryCheck.errors.map(error =>
            `${error.field}: ${error.error}${error.suggestion ? ' ' + error.suggestion : ''}`
          ).join('; ');
          throw new Error(`Docker directory conflict: ${errorDetails}`);
        }
      }

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Invalid field: ${key}`);
        }
        if (key === 'docker_net') {
          // Docker-Netzwerk configuration handling
          if (!current.docker_net) current.docker_net = {};

          // Validation of docker_net structure
          if (typeof updates.docker_net === 'object') {
            // Mode validation
            if (updates.docker_net.mode !== undefined) {
              const validModes = ['macvlan', 'ipvlan'];
              if (!validModes.includes(updates.docker_net.mode)) {
                throw new Error(`Invalid docker_net mode: ${updates.docker_net.mode}. Valid modes: ${validModes.join(', ')}`);
              }
              current.docker_net.mode = updates.docker_net.mode;
            }

            // Config validation and adoption
            if (Array.isArray(updates.docker_net.config)) {
              // Validation of config entries
              for (const configEntry of updates.docker_net.config) {
                if (typeof configEntry !== 'object') {
                  throw new Error('docker_net.config entries must be objects');
                }
                // Subnet validation if present
                if (configEntry.subnet && !/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(configEntry.subnet)) {
                  throw new Error(`Invalid subnet format: ${configEntry.subnet}. Expected format: x.x.x.x/xx`);
                }
                // Gateway validation if present
                if (configEntry.gateway && !/^(\d{1,3}\.){3}\d{1,3}$/.test(configEntry.gateway)) {
                  throw new Error(`Invalid gateway format: ${configEntry.gateway}. Expected format: x.x.x.x`);
                }
              }
              current.docker_net.config = updates.docker_net.config;
            }
          }
        } else if (key === 'update_check') {
          // Intelligent update_check handling - only changed fields are overwritten
          if (!current.update_check) current.update_check = {};

          const currentUpdateCheck = JSON.parse(JSON.stringify(current.update_check)); // Deep copy for comparison

          // If only a boolean is sent, it is for enabled
          if (typeof updates.update_check === 'boolean') {
            if (current.update_check.enabled !== updates.update_check) {
              updateCheckChanged = true;
            }
            current.update_check.enabled = updates.update_check;
          } else if (typeof updates.update_check === 'object') {
            // Individual update_check properties are adopted
            if (updates.update_check.enabled !== undefined &&
                current.update_check.enabled !== updates.update_check.enabled) {
              updateCheckChanged = true;
            }
            if (updates.update_check.update_check_schedule !== undefined &&
                current.update_check.update_check_schedule !== updates.update_check.update_check_schedule) {
              updateCheckChanged = true;
            }

            // auto_update handling
            if (updates.update_check.auto_update) {
              if (!current.update_check.auto_update) current.update_check.auto_update = {};

              if (updates.update_check.auto_update.enabled !== undefined &&
                  current.update_check.auto_update.enabled !== updates.update_check.auto_update.enabled) {
                updateCheckChanged = true;
              }
              if (updates.update_check.auto_update.auto_update_schedule !== undefined &&
                  current.update_check.auto_update.auto_update_schedule !== updates.update_check.auto_update.auto_update_schedule) {
                updateCheckChanged = true;
              }

              // auto_update properties are adopted
              if (updates.update_check.auto_update.enabled !== undefined)
                current.update_check.auto_update.enabled = updates.update_check.auto_update.enabled;
              if (updates.update_check.auto_update.auto_update_schedule !== undefined)
                current.update_check.auto_update.auto_update_schedule = updates.update_check.auto_update.auto_update_schedule;
            }

            // Main properties are adopted
            if (updates.update_check.enabled !== undefined)
              current.update_check.enabled = updates.update_check.enabled;
            if (updates.update_check.update_check_schedule !== undefined)
              current.update_check.update_check_schedule = updates.update_check.update_check_schedule;
          }
        } else {
          current[key] = updates[key];
        }
      }

      // Write the file
      await fs.writeFile(this.settingsPath, JSON.stringify(current, null, 2), 'utf8');

      // Docker service stop/start on configuration changes
      try {
        // Docker always stop when configuration is changed
        // Ignore errors on stop (e.g. if service is already stopped)
        try {
          await execPromise('/etc/init.d/docker stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        // Docker start only if enabled = true (mos-start reads the new file)
        if (current.enabled === true) {
          await execPromise('/usr/local/bin/mos-start docker');
        }
      } catch (error) {
        throw new Error(`Error restarting docker service: ${error.message}`);
      }

      // mos-cron_update execute if update_check changed
      if (updateCheckChanged) {
        try {
          await execPromise('/usr/local/bin/mos-cron_update');
        } catch (error) {
          console.warn('Warning: mos-cron_update could not be executed:', error.message);
        }
      }

      return current;
    } catch (error) {
      throw new Error(`Error writing docker.json: ${error.message}`);
    }
  }

  /**
   * Returns the default LXC settings structure with all expected fields
   * @returns {Promise<Object>} Default LXC settings
   */
  async _getDefaultLxcSettings() {
    const defaultPoolName = await this._getFirstNonMergerFSPool();
    const defaultPaths = defaultPoolName ? this._generateDefaultPaths(defaultPoolName) : null;

    return {
      enabled: false,
      bridge: false,
      directory: defaultPaths ? defaultPaths.lxc.directory : null,
      start_wait: 0
    };
  }

  /**
   * Reads the LXC settings from the lxc.json file.
   * Ensures all expected fields are present by merging with defaults.
   * @returns {Promise<Object>} The LXC settings as an object
   */
  async getLxcSettings() {
    try {
      const defaults = await this._getDefaultLxcSettings();

      let loadedSettings = {};
      try {
        const data = await fs.readFile('/boot/config/lxc.json', 'utf8');
        loadedSettings = JSON.parse(data);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.warn('lxc.json not found, returning defaults');
          return defaults;
        }
        throw error;
      }

      // Merge loaded settings with defaults (loaded settings take precedence)
      const settings = this._deepMerge(defaults, loadedSettings);

      // Set default path if directory is still null
      if (settings.directory === null) {
        const defaultPoolName = await this._getFirstNonMergerFSPool();
        if (defaultPoolName) {
          const defaultPaths = this._generateDefaultPaths(defaultPoolName);
          settings.directory = defaultPaths.lxc.directory;
        }
      }

      return settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('lxc.json not found');
      }
      throw new Error(`Error reading lxc.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the lxc.json. Only the passed fields are changed.
   * If enabled is changed, the LXC service is stopped/started.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateLxcSettings(updates) {
    try {
      // Read current settings with defaults
      const defaults = await this._getDefaultLxcSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/lxc.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        // Merge loaded settings with defaults
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Only allowed fields are updated
      const allowed = ['enabled', 'bridge', 'directory', 'start_wait'];

      // Check directory paths for mount status
      const pathsToCheck = {};
      if (updates.directory && updates.directory !== current.directory) {
        pathsToCheck.directory = updates.directory;
      }

      if (Object.keys(pathsToCheck).length > 0) {
        const directoryCheck = await this._checkMultipleDirectories(pathsToCheck, 'lxc');

        if (directoryCheck.hasErrors) {
          const errorDetails = directoryCheck.errors.map(error =>
            `${error.field}: ${error.error}${error.suggestion ? ' ' + error.suggestion : ''}`
          ).join('; ');
          throw new Error(`LXC directory conflict: ${errorDetails}`);
        }
      }

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Invalid field: ${key}`);
        }
        current[key] = updates[key];
      }

      // Write the file
      await fs.writeFile('/boot/config/lxc.json', JSON.stringify(current, null, 2), 'utf8');

      // LXC service stop/start on configuration changes
      try {
        // LXC always stop when configuration is changed
        // Ignore errors on stop (e.g. if service is already stopped)
        try {
          await exec('/etc/init.d/lxc stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        try {
          await exec('/etc/init.d/lxc-net stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        // LXC only start if enabled = true (mos-start reads the new file)
        if (current.enabled === true) {
          await execPromise('/usr/local/bin/mos-start lxc');
        }
      } catch (error) {
        throw new Error(`Error restarting lxc service: ${error.message}`);
      }

      return current;
    } catch (error) {
      throw new Error(`Error writing lxc.json: ${error.message}`);
    }
  }

  /**
   * Returns the default VM settings structure with all expected fields
   * @returns {Promise<Object>} Default VM settings
   */
  async _getDefaultVmSettings() {
    const defaultPoolName = await this._getFirstNonMergerFSPool();
    const defaultPaths = defaultPoolName ? this._generateDefaultPaths(defaultPoolName) : null;

    return {
      enabled: false,
      directory: defaultPaths ? defaultPaths.vm.directory : null,
      vdisk_directory: defaultPaths ? defaultPaths.vm.vdisk_directory : null,
      start_wait: 0
    };
  }

  /**
   * Reads the VM settings from the vm.json file.
   * Ensures all expected fields are present by merging with defaults.
   * @returns {Promise<Object>} The VM settings as an object
   */
  async getVmSettings() {
    try {
      const defaults = await this._getDefaultVmSettings();

      let loadedSettings = {};
      try {
        const data = await fs.readFile('/boot/config/vm.json', 'utf8');
        loadedSettings = JSON.parse(data);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.warn('vm.json not found, returning defaults');
          return defaults;
        }
        throw error;
      }

      // Merge loaded settings with defaults (loaded settings take precedence)
      const settings = this._deepMerge(defaults, loadedSettings);

      // Set default paths if values are still null
      if (settings.directory === null || settings.vdisk_directory === null) {
        const defaultPoolName = await this._getFirstNonMergerFSPool();
        if (defaultPoolName) {
          const defaultPaths = this._generateDefaultPaths(defaultPoolName);
          if (settings.directory === null) {
            settings.directory = defaultPaths.vm.directory;
          }
          if (settings.vdisk_directory === null) {
            settings.vdisk_directory = defaultPaths.vm.vdisk_directory;
          }
        }
      }

      return settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('vm.json not found');
      }
      throw new Error(`Error reading vm.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the vm.json. Only the passed fields are changed.
   * If enabled is changed, the libvirtd service is stopped/started.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateVmSettings(updates) {
    try {
      // Read current settings with defaults
      const defaults = await this._getDefaultVmSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/vm.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        // Merge loaded settings with defaults
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Only allowed fields are updated
      const allowed = ['enabled', 'directory', 'vdisk_directory', 'start_wait'];

      // Check directory paths for mount status
      const pathsToCheck = {};
      if (updates.directory && updates.directory !== current.directory) {
        pathsToCheck.directory = updates.directory;
      }
      if (updates.vdisk_directory && updates.vdisk_directory !== current.vdisk_directory) {
        pathsToCheck.vdisk_directory = updates.vdisk_directory;
      }

      if (Object.keys(pathsToCheck).length > 0) {
        const directoryCheck = await this._checkMultipleDirectories(pathsToCheck, 'vm');

        if (directoryCheck.hasErrors) {
          const errorDetails = directoryCheck.errors.map(error =>
            `${error.field}: ${error.error}${error.suggestion ? ' ' + error.suggestion : ''}`
          ).join('; ');
          throw new Error(`VM directory conflict: ${errorDetails}`);
        }
      }

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Invalid field: ${key}`);
        }
        current[key] = updates[key];
      }

      // Write the file
      await fs.writeFile('/boot/config/vm.json', JSON.stringify(current, null, 2), 'utf8');

      // libvirtd service stop/start on configuration changes
      try {
        // VM services always stop when configuration is changed
        // Ignore errors on stop (e.g. if service is already stopped)
        try {
          await execPromise('/etc/init.d/libvirtd stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        try {
          await execPromise('/etc/init.d/virtlogd stop');
        } catch (stopError) {
          // Ignore stop errors (service could already be stopped)
        }

        // VM services only start if enabled = true (mos-start reads the new file)
        if (current.enabled === true) {
          await execPromise('/usr/local/bin/mos-start vm');
        }
      } catch (error) {
        throw new Error(`Error restarting vm service: ${error.message}`);
      }

      return current;
    } catch (error) {
      throw new Error(`Error writing vm.json: ${error.message}`);
    }
  }

  /**
   * Returns the default network settings structure with all expected fields
   * @returns {Object} Default network settings
   */
  _getDefaultNetworkSettings() {
    return {
      interfaces: [
        {
          name: 'eth0',
          type: 'ethernet',
          mode: null,
          interfaces: [],
          ipv4: [{ dhcp: true }],
          ipv6: []
        }
      ],
      services: {
        ssh: { enabled: true },
        samba: { enabled: false },
        nmbd: { enabled: false },
        nfs: { enabled: false },
        remote_mounting: { enabled: false },
        nut: { enabled: false },
        iscsi_target: { enabled: false },
        iscsi_initiator: { enabled: false },
        tailscale: {
          enabled: false,
          update_check: false,
          tailscaled_params: ''
        },
        netbird: {
          enabled: false,
          update_check: false,
          netbird_service_params: ''
        }
      }
    };
  }

  /**
   * Deep merges two objects, with source values taking precedence
   * @param {Object} target - Target object (defaults)
   * @param {Object} source - Source object (loaded settings)
   * @returns {Object} Merged object
   */
  _deepMerge(target, source) {
    const result = { ...target };

    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        // Recursive merge for nested objects
        result[key] = this._deepMerge(result[key] || {}, source[key]);
      } else {
        // Direct assignment for primitives and arrays
        result[key] = source[key];
      }
    }

    return result;
  }

  /**
   * Reads the Network-Settings from the network.json file.
   * Ensures all expected fields are present by merging with defaults.
   * @returns {Promise<Object>} The Network-Settings as an object
   */
  async getNetworkSettings() {
    try {
      const defaults = this._getDefaultNetworkSettings();

      let loadedSettings = {};
      try {
        const data = await fs.readFile('/boot/config/network.json', 'utf8');
        loadedSettings = JSON.parse(data);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // If file doesn't exist, return defaults
          console.warn('network.json not found, returning defaults');
          return defaults;
        }
        throw error;
      }

      // Merge loaded settings with defaults (loaded settings take precedence)
      const settings = this._deepMerge(defaults, loadedSettings);

      return settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('network.json not found');
      }
      throw new Error(`Error reading network.json: ${error.message}`);
    }
  }

  /**
   * Reads only the network interfaces from the network.json file.
   * @returns {Promise<Array>} Array of network interfaces
   */
  async getNetworkInterfaces() {
    try {
      const settings = await this.getNetworkSettings();
      return settings.interfaces || [];
    } catch (error) {
      throw new Error(`Error reading network interfaces: ${error.message}`);
    }
  }

  /**
   * Reads only the network services from the network.json file.
   * @returns {Promise<Object>} Network services object
   */
  async getNetworkServices() {
    try {
      const settings = await this.getNetworkSettings();
      return settings.services || {};
    } catch (error) {
      throw new Error(`Error reading network services: ${error.message}`);
    }
  }

  /**
   * Updates only the network interfaces in the network.json file.
   * @param {Array} interfaces - Array of network interfaces
   * @returns {Promise<Array>} The updated interfaces array
   */
  async updateNetworkInterfaces(interfaces) {
    try {
      if (!Array.isArray(interfaces)) {
        throw new Error('interfaces must be an array');
      }

      // Read current settings
      const defaults = this._getDefaultNetworkSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/network.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      // Track interface changes
      let interfacesChanged = false;
      let primaryInterfaceChanged = false;
      let oldPrimaryInterface = this._determinePrimaryInterface(current.interfaces || []);

      // Check if anything has changed
      if (JSON.stringify(current.interfaces) !== JSON.stringify(interfaces)) {
        interfacesChanged = true;
      }

      // Analyze current and new interface states
      const currentEth0 = current.interfaces.find(iface => iface.name === 'eth0');
      const currentBr0 = current.interfaces.find(iface => iface.name === 'br0');
      const newEth0 = interfaces.find(iface => iface.name === 'eth0');
      const newBr0 = interfaces.find(iface => iface.name === 'br0');

      // Interfaces directly assign (only new format supported)
      current.interfaces = interfaces;

      // Bridge logic: eth0 set to bridged and br0 is missing
      if (newEth0 && newEth0.type === 'bridged' && !newBr0) {
        // Automatically create br0 Bridge-Interface
        const br0Interface = {
          name: 'br0',
          type: 'bridge',
          mode: null,
          interfaces: ['eth0'],
          ipv4: newEth0.ipv4 && newEth0.ipv4.length > 0 ? newEth0.ipv4 : [{ dhcp: false }],
          ipv6: []
        };

        // Reset eth0 (bridged interfaces have no IP configuration)
        newEth0.ipv4 = [];
        newEth0.ipv6 = [];

        current.interfaces.push(br0Interface);
        interfacesChanged = true;
      }

      // Bridge logic: eth0 from bridged to ethernet and br0 exists
      if (newEth0 && newEth0.type === 'ethernet' && currentBr0) {
        // IP configuration from br0 to eth0 (new format)
        if (currentBr0.ipv4 && Array.isArray(currentBr0.ipv4) && currentBr0.ipv4.length > 0) {
          newEth0.ipv4 = currentBr0.ipv4;
        }

        // br0 aus interfaces entfernen
        current.interfaces = current.interfaces.filter(iface => iface.name !== 'br0');
        interfacesChanged = true;
      }

      // Validation for static IP configuration
      for (const iface of current.interfaces) {
        // Skip validation for bridged interfaces (they don't need IP configuration)
        if (iface.type === 'bridged') {
          continue;
        }

        if (iface.ipv4 && Array.isArray(iface.ipv4)) {
          for (const ipv4Config of iface.ipv4) {
            if (ipv4Config.dhcp === false && !ipv4Config.address) {
              throw new Error(`Interface ${iface.name}: address is required when dhcp=false`);
            }
          }
        }
      }

      // Check if primary interface has changed
      const newPrimaryInterface = this._determinePrimaryInterface(current.interfaces || []);
      if (oldPrimaryInterface !== newPrimaryInterface) {
        primaryInterfaceChanged = true;
      }

      // Write updated settings
      await fs.writeFile('/boot/config/network.json', JSON.stringify(current, null, 2), 'utf8');

      // Update LXC default.conf if interfaces or primary interface have changed
      if (interfacesChanged || primaryInterfaceChanged) {
        await this._updateLxcDefaultConf(newPrimaryInterface, current.interfaces);
      }

      // Networking restart if interfaces have changed
      if (interfacesChanged) {
        await execPromise('/etc/init.d/networking restart');
      }

      return current.interfaces;
    } catch (error) {
      throw new Error(`Error updating network interfaces: ${error.message}`);
    }
  }

  /**
   * Updates only the network services in the network.json file.
   * @param {Object} services - Network services object
   * @returns {Promise<Object>} The updated services object
   */
  async updateNetworkServices(services) {
    try {
      if (!services || typeof services !== 'object') {
        throw new Error('services must be an object');
      }

      // Read current settings
      const defaults = this._getDefaultNetworkSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/network.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      // Track service changes
      let sambaChanged = false, sambaValue = null;
      let nfsChanged = false, nfsValue = null;
      let nutChanged = false, nutValue = null;
      let sshChanged = false, sshValue = null;
      let nmbdChanged = false, nmbdValue = null;
      let tailscaleChanged = false, tailscaleValue = null;
      let netbirdChanged = false, netbirdValue = null;
      let remoteMountingChanged = false, remoteMountingValue = null;

      // Handle remote_mounting setting
      if (services.remote_mounting && typeof services.remote_mounting === 'object') {
        if (!current.services) current.services = {};
        if (!current.services.remote_mounting) current.services.remote_mounting = {};
        if (typeof services.remote_mounting.enabled === 'boolean') {
          if (current.services.remote_mounting.enabled !== services.remote_mounting.enabled) {
            remoteMountingChanged = true;
            remoteMountingValue = services.remote_mounting.enabled;
          }
          current.services.remote_mounting.enabled = services.remote_mounting.enabled;
        }
      }

      // Handle samba service
      if (services.samba && typeof services.samba.enabled === 'boolean') {
        if (!current.services) current.services = {};
        if (!current.services.samba) current.services.samba = {};
        if (current.services.samba.enabled !== services.samba.enabled) {
          sambaChanged = true;
          sambaValue = services.samba.enabled;
        }
        current.services.samba.enabled = services.samba.enabled;
      }

      // Handle nfs service
      if (services.nfs && typeof services.nfs.enabled === 'boolean') {
        if (!current.services) current.services = {};
        if (!current.services.nfs) current.services.nfs = {};
        if (current.services.nfs.enabled !== services.nfs.enabled) {
          nfsChanged = true;
          nfsValue = services.nfs.enabled;
        }
        current.services.nfs.enabled = services.nfs.enabled;
        // Add exports if necessary
        if (Array.isArray(services.nfs.exports)) {
          current.services.nfs.exports = services.nfs.exports;
        }
      }

      // Handle nut service
      if (services.nut && typeof services.nut.enabled === 'boolean') {
        if (!current.services) current.services = {};
        if (!current.services.nut) current.services.nut = {};
        if (current.services.nut.enabled !== services.nut.enabled) {
          nutChanged = true;
          nutValue = services.nut.enabled;
        }
        current.services.nut.enabled = services.nut.enabled;
      }

      // Handle ssh service
      if (services.ssh && typeof services.ssh.enabled === 'boolean') {
        if (!current.services) current.services = {};
        if (!current.services.ssh) current.services.ssh = {};
        if (current.services.ssh.enabled !== services.ssh.enabled) {
          sshChanged = true;
          sshValue = services.ssh.enabled;
        }
        current.services.ssh.enabled = services.ssh.enabled;
      }

      // Handle nmbd service
      if (services.nmbd && typeof services.nmbd.enabled === 'boolean') {
        if (!current.services) current.services = {};
        if (!current.services.nmbd) current.services.nmbd = {};
        if (current.services.nmbd.enabled !== services.nmbd.enabled) {
          nmbdChanged = true;
          nmbdValue = services.nmbd.enabled;
        }
        current.services.nmbd.enabled = services.nmbd.enabled;
      }

      // Handle tailscale service
      if (services.tailscale) {
        if (!current.services) current.services = {};
        if (!current.services.tailscale) current.services.tailscale = {};
        if (typeof services.tailscale.enabled === 'boolean' &&
            current.services.tailscale.enabled !== services.tailscale.enabled) {
          tailscaleChanged = true;
          tailscaleValue = services.tailscale.enabled;
        }
        if (services.tailscale.enabled !== undefined)
          current.services.tailscale.enabled = services.tailscale.enabled;
        if (services.tailscale.update_check !== undefined)
          current.services.tailscale.update_check = services.tailscale.update_check;
        if (services.tailscale.tailscaled_params !== undefined)
          current.services.tailscale.tailscaled_params = services.tailscale.tailscaled_params;
      }

      // Handle netbird service
      if (services.netbird) {
        if (!current.services) current.services = {};
        if (!current.services.netbird) current.services.netbird = {};
        if (typeof services.netbird.enabled === 'boolean' &&
            current.services.netbird.enabled !== services.netbird.enabled) {
          netbirdChanged = true;
          netbirdValue = services.netbird.enabled;
        }
        if (services.netbird.enabled !== undefined)
          current.services.netbird.enabled = services.netbird.enabled;
        if (services.netbird.update_check !== undefined)
          current.services.netbird.update_check = services.netbird.update_check;
        if (services.netbird.netbird_service_params !== undefined)
          current.services.netbird.netbird_service_params = services.netbird.netbird_service_params;
      }

      // Write updated settings
      await fs.writeFile('/boot/config/network.json', JSON.stringify(current, null, 2), 'utf8');

      // Handle remote mounting changes
      if (remoteMountingChanged && !remoteMountingValue) {
        // If remote mounting is disabled, unmount all remotes
        try {
          const RemotesService = require('./remotes.service');
          const remotesService = new RemotesService();
          await remotesService.unmountAllRemotes();
          console.log('All remotes unmounted due to remote_mounting being disabled');
        } catch (error) {
          console.warn('Failed to unmount remotes when disabling remote_mounting:', error.message);
        }
      }

      // Services stop/start
      if (sambaChanged) {
        if (sambaValue === false) {
          await execPromise('/etc/init.d/smbd stop');
        } else if (sambaValue === true) {
          await execPromise('/etc/init.d/smbd start');
        }
      }
      if (nfsChanged) {
        if (nfsValue === false) {
          await execPromise('/etc/init.d/umountnfs.sh stop');
        } else if (nfsValue === true) {
          await execPromise('/etc/init.d/mountnfs.sh start');
        }
      }
      if (nutChanged) {
        if (nutValue === false) {
          await execPromise('/etc/init.d/nut-client stop');
          await execPromise('/etc/init.d/nut-server stop');
        } else if (nutValue === true) {
          await execPromise('/etc/init.d/nut-client start');
          await execPromise('/etc/init.d/nut-server start');
        }
      }
      if (sshChanged) {
        if (sshValue === false) {
          await execPromise('/etc/init.d/ssh stop');
        } else if (sshValue === true) {
          await execPromise('/etc/init.d/ssh start');
        }
      }
      if (nmbdChanged) {
        if (nmbdValue === false) {
          await execPromise('/etc/init.d/nmbd stop');
        } else if (nmbdValue === true) {
          await execPromise('/etc/init.d/nmbd start');
        }
      }
      if (tailscaleChanged) {
        if (tailscaleValue === false) {
          await execPromise('/etc/init.d/tailscaled stop');
        } else if (tailscaleValue === true) {
          await execPromise('/etc/init.d/tailscaled start');
        }
      }
      if (netbirdChanged) {
        if (netbirdValue === false) {
          await execPromise('/etc/init.d/netbird stop');
        } else if (netbirdValue === true) {
          await execPromise('/etc/init.d/netbird start');
        }
      }

      return current.services;
    } catch (error) {
      throw new Error(`Error updating network services: ${error.message}`);
    }
  }

  /**
   * Get available CPU governors from the system
   * @returns {Promise<Array>} Array of available governors
   */
  async getAvailableGovernors() {
    try {
      // Try to read from cpufreq system file first
      try {
        const data = await fs.readFile('/sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors', 'utf8');
        const governors = data.trim().split(/\s+/).filter(gov => gov.length > 0);
        return governors;
      } catch (sysError) {
        // Fallback: try cpufreq-info if available
        try {
          const { stdout } = await execPromise('cpufreq-info --governors 2>/dev/null');
          const governors = stdout.trim().split(/\s+/).filter(gov => gov.length > 0);
          if (governors.length > 0) {
            return governors;
          }
        } catch (cpufreqError) {
          // Ignore cpufreq-info errors
        }

        // If both methods fail, return common default governors
        console.warn('Could not read available governors, returning defaults');
        return ['ondemand', 'performance', 'powersave', 'conservative'];
      }
    } catch (error) {
      throw new Error(`Fehler beim Abrufen der verfügbaren Governors: ${error.message}`);
    }
  }

  /**
   * Returns the default system settings structure with all expected fields
   * @returns {Object} Default system settings
   */
  _getDefaultSystemSettings() {
    return {
      hostname: 'MOS',
      global_spindown: 0,
      keymap: 'us',
      timezone: 'America/New_York',
      display: {
        timeout: 30,
        powersave: 'on',
        powerdown: 60
      },
      persist_history: false,
      ntp: {
        enabled: true,
        server: 'pool.ntp.org'
      },
      notification_sound: {
        startup: true,
        reboot: true,
        shutdown: true
      },
      cpufreq: {
        governor: 'ondemand',
        max_speed: 0,
        min_speed: 0
      }
    };
  }

  /**
   * Reads the system settings from the system.json file.
   * Ensures all expected fields are present by merging with defaults.
   * @returns {Promise<Object>} The system settings as an object
   */
  async getSystemSettings() {
    try {
      const defaults = this._getDefaultSystemSettings();

      let loadedSettings = {};
      try {
        const data = await fs.readFile('/boot/config/system.json', 'utf8');
        loadedSettings = JSON.parse(data);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.warn('system.json not found, returning defaults');
          return defaults;
        }
        throw error;
      }

      // Merge loaded settings with defaults (loaded settings take precedence)
      const settings = this._deepMerge(defaults, loadedSettings);

      return settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('system.json nicht gefunden');
      }
      throw new Error(`Fehler beim Lesen der system.json: ${error.message}`);
    }
  }

  /**
   * Writes new values to the system.json. Only hostname and global_spindown are accepted.
   * @param {Object} updates - The fields to update
   * @returns {Promise<Object>} The updated settings
   */
  async updateSystemSettings(updates) {
    try {
      // Read current settings with defaults
      const defaults = this._getDefaultSystemSettings();
      let current = { ...defaults };

      try {
        const data = await fs.readFile('/boot/config/system.json', 'utf8');
        const loadedSettings = JSON.parse(data);
        // Merge loaded settings with defaults
        current = this._deepMerge(defaults, loadedSettings);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Only allowed fields are updated
      const allowed = ['hostname', 'global_spindown', 'keymap', 'timezone', 'display', 'persist_history', 'ntp', 'notification_sound', 'cpufreq'];
      let ntpChanged = false;
      let keymapChanged = false;
      let timezoneChanged = false;
      let displayChanged = false;
      let persistHistoryChanged = false;
      let persistHistoryValue = null;
      let cpufreqChanged = false;

      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error(`Ungültiges Feld: ${key}`);
        }

        if (key === 'ntp') {
          // Update NTP settings
          if (!current.ntp) current.ntp = {};

          // Check if enabled has changed
          if (updates.ntp.enabled !== undefined && updates.ntp.enabled !== current.ntp.enabled) {
            ntpChanged = true;
          }

          // Check if other NTP settings have changed and service is active
          if (current.ntp.enabled === true && (
            (updates.ntp.mode !== undefined && updates.ntp.mode !== current.ntp.mode) ||
            (Array.isArray(updates.ntp.servers) && JSON.stringify(updates.ntp.servers) !== JSON.stringify(current.ntp.servers))
          )) {
            ntpChanged = true;
          }

          // Update NTP settings
          if (updates.ntp.enabled !== undefined) current.ntp.enabled = updates.ntp.enabled;
          if (updates.ntp.mode !== undefined) current.ntp.mode = updates.ntp.mode;
          if (Array.isArray(updates.ntp.servers)) current.ntp.servers = updates.ntp.servers;
        } else if (key === 'keymap') {
          if (updates.keymap !== current.keymap) {
            keymapChanged = true;
          }
          current[key] = updates[key];
        } else if (key === 'timezone') {
          if (updates.timezone !== current.timezone) {
            timezoneChanged = true;
          }
          current[key] = updates[key];
        } else if (key === 'persist_history') {
          if (updates.persist_history !== current.persist_history && updates.persist_history === true) {
            persistHistoryChanged = true;
            persistHistoryValue = true;
          }
          current[key] = updates[key];
        } else if (key === 'display') {
          // Initialize display with defaults if not present
          if (!current.display) {
            current.display = {
              timeout: 30,
              powersave: 'on',
              powerdown: 60
            };
          }

          // Update display settings
          if (typeof updates.display === 'object' && updates.display !== null) {
            // Check if any display setting changed
            if (updates.display.timeout !== undefined && updates.display.timeout !== current.display.timeout) {
              displayChanged = true;
            }
            if (updates.display.powersave !== undefined && updates.display.powersave !== current.display.powersave) {
              displayChanged = true;
            }
            if (updates.display.powerdown !== undefined && updates.display.powerdown !== current.display.powerdown) {
              displayChanged = true;
            }

            // Merge with existing settings, keeping defaults for missing values
            current.display = {
              timeout: updates.display.timeout !== undefined ? updates.display.timeout : current.display.timeout,
              powersave: updates.display.powersave !== undefined ? updates.display.powersave : current.display.powersave,
              powerdown: updates.display.powerdown !== undefined ? updates.display.powerdown : current.display.powerdown
            };
          }
        } else if (key === 'notification_sound') {
          // Initialize notification_sound with defaults if not present
          if (!current.notification_sound) {
            current.notification_sound = {
              startup: true,
              reboot: true,
              shutdown: true
            };
          }

          // Update notification_sound settings
          if (typeof updates.notification_sound === 'object' && updates.notification_sound !== null) {
            // Merge with existing settings, keeping defaults for missing values
            current.notification_sound = {
              startup: updates.notification_sound.startup !== undefined ? updates.notification_sound.startup : current.notification_sound.startup,
              reboot: updates.notification_sound.reboot !== undefined ? updates.notification_sound.reboot : current.notification_sound.reboot,
              shutdown: updates.notification_sound.shutdown !== undefined ? updates.notification_sound.shutdown : current.notification_sound.shutdown
            };
          }
        } else if (key === 'cpufreq') {
          // Initialize cpufreq with defaults if not present
          if (!current.cpufreq) {
            current.cpufreq = {
              governor: 'ondemand',
              max_speed: 0,
              min_speed: 0
            };
          }

          // Update cpufreq settings
          if (typeof updates.cpufreq === 'object' && updates.cpufreq !== null) {
            // Check if any cpufreq setting changed
            if (updates.cpufreq.governor !== undefined && updates.cpufreq.governor !== current.cpufreq.governor) {
              cpufreqChanged = true;
            }
            if (updates.cpufreq.max_speed !== undefined && updates.cpufreq.max_speed !== current.cpufreq.max_speed) {
              cpufreqChanged = true;
            }
            if (updates.cpufreq.min_speed !== undefined && updates.cpufreq.min_speed !== current.cpufreq.min_speed) {
              cpufreqChanged = true;
            }

            // Merge with existing settings, keeping defaults for missing values
            current.cpufreq = {
              governor: updates.cpufreq.governor !== undefined ? updates.cpufreq.governor : current.cpufreq.governor,
              max_speed: updates.cpufreq.max_speed !== undefined ? updates.cpufreq.max_speed : current.cpufreq.max_speed,
              min_speed: updates.cpufreq.min_speed !== undefined ? updates.cpufreq.min_speed : current.cpufreq.min_speed
            };
          }
        } else {
          current[key] = updates[key];
        }
      }

      // Write file
      await fs.writeFile('/boot/config/system.json', JSON.stringify(current, null, 2), 'utf8');

      // NTP service stop/start/restart if changed
      if (ntpChanged) {
        if (current.ntp.enabled === false) {
          await execPromise('/etc/init.d/ntpsec stop');
        } else if (current.ntp.enabled === true) {
          // If service was already active and settings have changed, restart
          if (updates.ntp && (updates.ntp.mode !== undefined || Array.isArray(updates.ntp.servers))) {
            await execPromise('/etc/init.d/ntpsec restart');
          } else {
            await execPromise('/etc/init.d/ntpsec start');
          }
        }
      }

      // Keymap directly into system load
      if (keymapChanged) {
        await execPromise(`loadkeys ${current.keymap}`);
      }

      // Timezone directly into system set
      if (timezoneChanged) {
        await execPromise(`ln -sf /usr/share/zoneinfo/${current.timezone} /etc/localtime`);
      }

      // Persist history setup
      if (persistHistoryChanged && persistHistoryValue === true) {
        try {
          // Remove old bash_history file
          await execPromise('rm -f /root/.bash_history');
          // Create directory if it doesn't exist
          await execPromise('mkdir -p /boot/config/system');
          // Create new bash_history file
          await execPromise('touch /boot/config/system/.bash_history');
          // Create symlink
          await execPromise('ln -s /boot/config/system/.bash_history /root/.bash_history');
        } catch (error) {
          console.warn('Warning: Could not setup persistent bash history:', error.message);
        }
      }

      // Display settings apply with setterm
      if (displayChanged && current.display) {
        try {
          const settermArgs = [];

          // Add --blank parameter for timeout
          if (current.display.timeout !== undefined && current.display.timeout !== null) {
            settermArgs.push(`--blank ${current.display.timeout}`);
          }

          // Add --powersave parameter
          if (current.display.powersave !== undefined && current.display.powersave !== null) {
            settermArgs.push(`--powersave ${current.display.powersave}`);
          }

          // Add --powerdown parameter
          if (current.display.powerdown !== undefined && current.display.powerdown !== null) {
            settermArgs.push(`--powerdown ${current.display.powerdown}`);
          }

          // Execute setterm command if we have arguments
          if (settermArgs.length > 0) {
            const settermCmd = `setterm ${settermArgs.join(' ')}`;
            await execPromise(settermCmd);
          }
        } catch (error) {
          console.warn('Warning: Could not apply display settings with setterm:', error.message);
        }
      }

      // CPU frequency scaling settings apply with cpupower service
      if (cpufreqChanged) {
        try {
          await execPromise('/etc/init.d/cpupower start');
        } catch (error) {
          console.warn('Warning: Could not apply cpufreq settings with cpupower:', error.message);
        }
      }

      return current;
    } catch (error) {
      throw new Error(`Fehler beim Schreiben der system.json: ${error.message}`);
    }
  }

  async listKeymaps() {
    try {
      const keymaps = [];
      const basePath = '/usr/share/keymaps/i386';
      const subdirs = await fs.readdir(basePath);

      for (const subdir of subdirs) {
        const subdirPath = `${basePath}/${subdir}`;
        try {
          const files = await fs.readdir(subdirPath);
          const mapFiles = files.filter(f => f.endsWith('.kmap') || f.endsWith('.kmap.gz'));
          mapFiles.forEach(f => {
            const keymapName = f.replace(/\.kmap.gz$/, '');
            if (!keymaps.includes(keymapName)) {
              keymaps.push(keymapName);
            }
          });
        } catch (error) {
          continue;
        }
      }
      return keymaps.sort();
    } catch (error) {
      throw new Error('Fehler beim Lesen der Keymaps: ' + error.message);
    }
  }

  /**
   * Lists all available timezones under /usr/share/zoneinfo recursively (only files, no directories)
   * @returns {Promise<string[]>} Array of timezones (e.g. Europe/Vienna)
   */
  async listTimezones() {
    const basePath = '/usr/share/zoneinfo';
    const result = [];
    async function walk(dir, relPath = '') {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Skip hidden and special directories
          if (entry.name.startsWith('.')) continue;
          await walk(`${dir}/${entry.name}`, relPath ? `${relPath}/${entry.name}` : entry.name);
        } else if (entry.isFile()) {
          // Only real timezone files (no posix, right, localtime, etc.)
          if (['posix', 'right', 'localtime', 'posixrules', 'leapseconds', 'zone.tab', 'zone1970.tab', 'iso3166.tab', 'tzdata.zi', 'leap-seconds.list'].includes(entry.name)) continue;
          result.push(relPath ? `${relPath}/${entry.name}` : entry.name);
        }
      }
    }
    await walk(basePath);
    // Filter out right/ timezones
    const filteredResult = result.filter(tz => !tz.startsWith('right/'));
    return filteredResult.sort();
  }

  /**
   * Public method to check directory mount status
   * @param {string|Object} directoryPaths - Single path or object with paths {fieldName: path}
   * @returns {Promise<Object>} Check result
   */
  async checkDirectoryMountStatus(directoryPaths) {
    try {
      if (typeof directoryPaths === 'string') {
        // Einzelner Pfad
        const result = await this._checkDirectoryMountStatus(directoryPaths);
        return {
          path: directoryPaths,
          ...result
        };
      } else if (typeof directoryPaths === 'object') {
        // Mehrere Pfade
        const result = await this._checkMultipleDirectories(directoryPaths);
        return {
          hasErrors: result.hasErrors,
          directories: Object.keys(directoryPaths).map(fieldName => ({
            field: fieldName,
            path: directoryPaths[fieldName],
            ...result.results[fieldName]
          })),
          errors: result.errors
        };
      } else {
        throw new Error('directoryPaths must be a string or object');
      }
    } catch (error) {
      throw new Error(`Error checking directory mount status: ${error.message}`);
    }
  }

  /**
   * Update services
   * @param {string} service - Service name ('api' or 'nginx')
   * @returns {Promise<Object>} Update status
   */
  async updateService(service) {
    try {
      const allowedServices = ['api', 'nginx'];
      if (!allowedServices.includes(service)) {
        throw new Error(`Service '${service}' not allowed. Allowed: ${allowedServices.join(', ')}`);
      }

      // Create a detached child process that executes the update immediately
      const { spawn } = require('child_process');

      // Execute the update directly in a detached process
      const child = spawn('/etc/init.d/' + service, ['update'], {
        detached: true,
        stdio: 'ignore'
      });

      // Detach the child process from the parent, so it continues running even if the API is terminated
      child.unref();

      return {
        success: true,
        message: `${service} update initiated`,
        service,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      throw new Error(`Error initiating service updating: ${error.message}`);
    }
  }

  /**
   * Updates the API immediately
   * @returns {Promise<Object>} Update status
   */
  async updateApi() {
    return await this.updateService('api');
  }

  /**
   * Updates nginx immediately
   * @returns {Promise<Object>} Update status
   */
  async updateNginx() {
    return await this.updateService('nginx');
  }

  /**
   * Updates the LXC default.conf with the current primary interface and correct network type
   * @param {string} primaryInterface - The primary interface (br0 or eth0)
   * @param {Array} interfaces - Interface array from network.json for type determination
   * @returns {Promise<void>}
   */
  async _updateLxcDefaultConf(primaryInterface, interfaces = []) {
    try {
      const confPath = '/boot/config/system/lxc/default.conf';
      let confContent = '';

      // Determine the correct LXC Network Type
      const networkType = this._determineLxcNetworkType(primaryInterface, interfaces);

      try {
        confContent = await fs.readFile(confPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // File does not exist, create basic configuration
        confContent = `# LXC default configuration
lxc.net.0.type = ${networkType}
lxc.net.0.link = ${primaryInterface}
lxc.net.0.flags = up
lxc.net.0.hwaddr = 00:16:3e:xx:xx:xx
`;
      }

      // Replace the type line with the correct network type
      const typeRegex = /^lxc\.net\.0\.type\s*=\s*.+$/m;
      const newTypeLine = `lxc.net.0.type = ${networkType}`;

      if (typeRegex.test(confContent)) {
        confContent = confContent.replace(typeRegex, newTypeLine);
      } else {
        // Add the line if it doesn't exist
        confContent += `\nlxc.net.0.type = ${networkType}\n`;
      }

      // Replace the link line with the new interface
      const linkRegex = /^lxc\.net\.0\.link\s*=\s*.+$/m;
      const newLinkLine = `lxc.net.0.link = ${primaryInterface}`;

      if (linkRegex.test(confContent)) {
        confContent = confContent.replace(linkRegex, newLinkLine);
      } else {
        // Add the line if it doesn't exist
        confContent += `\nlxc.net.0.link = ${primaryInterface}\n`;
      }

      // Make sure the directory exists
      await fs.mkdir('/boot/config/system/lxc', { recursive: true });

      // Write the updated configuration
      await fs.writeFile(confPath, confContent, 'utf8');

      console.log(`LXC default.conf updated: lxc.net.0.type = ${networkType}, lxc.net.0.link = ${primaryInterface}`);
    } catch (error) {
      console.warn(`Warning: Could not update LXC default.conf: ${error.message}`);
    }
  }

  /**
   * Determines the correct LXC Network Type based on Interface Configuration
   * @param {string} primaryInterface - The primary interface (br0 or eth0)
   * @param {Array} interfaces - Interface array from network.json
   * @returns {string} LXC Network Type (veth, macvlan, etc.)
   */
  _determineLxcNetworkType(primaryInterface, interfaces = []) {
    if (!Array.isArray(interfaces)) {
      return 'veth'; // Standard fallback
    }

    const primaryIface = interfaces.find(iface => iface.name === primaryInterface);

    if (primaryIface) {
      // If it is a bridge, use veth
      if (primaryIface.type === 'bridge') {
        return 'veth';
      }

      // If it is a direct interface, use macvlan
      if (primaryIface.type === 'ethernet') {
        return 'macvlan';
      }

      // If it is a bridged interface, use veth
      if (primaryIface.type === 'bridged') {
        return 'veth';
      }
    }

    //  Fallback: Bridge-Interfaces verwenden veth, direkte Interfaces verwenden macvlan
    return primaryInterface === 'br0' ? 'veth' : 'macvlan';
  }



  /**
   * Determines the primary network interface based on the current configuration
   * @param {Array} interfaces - Interface array from network.json
   * @returns {string} The primary interface (br0 or eth0)
   */
  _determinePrimaryInterface(interfaces) {
    if (!Array.isArray(interfaces)) {
      return 'eth0';
    }

    // Check if br0 exists and is active
    const br0 = interfaces.find(iface => iface.name === 'br0');
    if (br0 && br0.type === 'bridge') {
      return 'br0';
    }

    // Check if eth0 is set to bridged
    const eth0 = interfaces.find(iface => iface.name === 'eth0');
    if (eth0 && eth0.type === 'bridged') {
      return 'br0';
    }

    // Default is eth0
    return 'eth0';
  }

  /**
   * Fast read of docker enabled status without loading defaults
   * @returns {Promise<boolean>} Docker enabled status
   */
  async _getDockerEnabledStatus() {
    try {
      const data = await fs.readFile(this.settingsPath, 'utf8');
      const settings = JSON.parse(data);
      return settings.enabled === true;
    } catch (error) {
      return false; // File not found or error - defaults to false
    }
  }

  /**
   * Check if Docker daemon is actually running via socket ping
   * @returns {Promise<boolean>} True if Docker daemon is responding
   */
  async _isDockerRunning() {
    try {
      const response = await axios({
        method: 'GET',
        url: 'http://localhost/_ping',
        socketPath: '/var/run/docker.sock',
        timeout: 2000,
        validateStatus: () => true
      });
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  /**
   * Fast read of LXC enabled status without loading defaults
   * @returns {Promise<boolean>} LXC enabled status
   */
  async _getLxcEnabledStatus() {
    try {
      const data = await fs.readFile('/boot/config/lxc.json', 'utf8');
      const settings = JSON.parse(data);
      return settings.enabled === true;
    } catch (error) {
      return false; // File not found or error - defaults to false
    }
  }

  /**
   * Fast read of VM enabled status without loading defaults
   * @returns {Promise<boolean>} VM enabled status
   */
  async _getVmEnabledStatus() {
    try {
      const data = await fs.readFile('/boot/config/vm.json', 'utf8');
      const settings = JSON.parse(data);
      return settings.enabled === true;
    } catch (error) {
      return false; // File not found or error - defaults to false
    }
  }

  /**
   * Check if a process with given PID is running
   * @param {number} pid - Process ID to check
   * @returns {Promise<boolean>} True if process is running
   */
  async _isProcessRunning(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if libvirt daemon is actually running via PID files
   * @returns {Promise<boolean>} True if libvirtd is running
   */
  async _isLibvirtRunning() {
    try {
      // Check libvirtd.pid
      const pidData = await fs.readFile('/var/run/libvirtd.pid', 'utf8');
      const pid = parseInt(pidData.trim(), 10);
      if (isNaN(pid)) return false;
      return await this._isProcessRunning(pid);
    } catch (error) {
      return false;
    }
  }

  /**
   * Fast read of network services status without loading defaults
   * @returns {Promise<Object>} Network services with enabled status
   */
  async _getNetworkServicesStatus() {
    try {
      const data = await fs.readFile('/boot/config/network.json', 'utf8');
      const settings = JSON.parse(data);
      const result = {};

      if (settings.services && typeof settings.services === 'object') {
        for (const [serviceName, serviceConfig] of Object.entries(settings.services)) {
          if (serviceConfig && typeof serviceConfig === 'object' && 'enabled' in serviceConfig) {
            result[serviceName] = {
              enabled: serviceConfig.enabled === true
            };
          }
        }
      }

      return result;
    } catch (error) {
      return {}; // File not found or error - return empty object
    }
  }

  /**
   * Gets the status of all services from different configuration files
   * Optimized version that only reads enabled flags without loading defaults
   * Also checks if services are actually running (not just configured)
   * @returns {Promise<Object>} Status object with all services (flat structure)
   */
  async getAllServiceStatus() {
    try {
      // Execute all status reads in parallel for maximum performance
      const [dockerEnabled, lxcEnabled, vmEnabled, hubEnabled, networkServices, dockerRunning, vmRunning] = await Promise.all([
        this._getDockerEnabledStatus(),
        this._getLxcEnabledStatus(),
        this._getVmEnabledStatus(),
        hubService.getHubEnabledStatus(),
        this._getNetworkServicesStatus(),
        this._isDockerRunning(),
        this._isLibvirtRunning()
      ]);

      const result = {
        docker: { enabled: dockerEnabled, running: dockerRunning },
        lxc: { enabled: lxcEnabled },
        vm: { enabled: vmEnabled, running: vmRunning },
        hub: { enabled: hubEnabled },
        ...networkServices
      };

      return result;
    } catch (error) {
      throw new Error(`Fehler beim Abrufen des Service-Status: ${error.message}`);
    }
  }

  /**
   * Compares two version strings for semantic version sorting
   * @param {string} versionA - First version string (e.g., "0.0.2-alpha.1")
   * @param {string} versionB - Second version string (e.g., "0.0.1-alpha.16")
   * @returns {number} Comparison result: positive if A > B, negative if A < B, 0 if equal
   */
  _compareVersions(versionA, versionB) {
    // Parse version strings into components
    const parseVersion = (version) => {
      // Remove 'v' prefix if present
      const cleanVersion = version.replace(/^v/, '');

      // Split into main version and pre-release parts
      const [mainVersion, preRelease] = cleanVersion.split('-');

      // Parse main version numbers
      const mainParts = mainVersion.split('.').map(num => parseInt(num, 10) || 0);

      // Ensure we have at least 3 parts for major.minor.patch
      while (mainParts.length < 3) {
        mainParts.push(0);
      }

      // Parse pre-release part
      let preReleaseType = '';
      let preReleaseNumber = 0;

      if (preRelease) {
        const preMatch = preRelease.match(/^(alpha|beta|rc)\.?(\d+)?$/i);
        if (preMatch) {
          preReleaseType = preMatch[1].toLowerCase();
          preReleaseNumber = parseInt(preMatch[2], 10) || 0;
        }
      }

      return {
        major: mainParts[0],
        minor: mainParts[1],
        patch: mainParts[2],
        preReleaseType,
        preReleaseNumber,
        isPreRelease: !!preRelease
      };
    };

    const vA = parseVersion(versionA);
    const vB = parseVersion(versionB);

    // Compare main version numbers (major.minor.patch)
    if (vA.major !== vB.major) return vA.major - vB.major;
    if (vA.minor !== vB.minor) return vA.minor - vB.minor;
    if (vA.patch !== vB.patch) return vA.patch - vB.patch;

    // If main versions are equal, handle pre-release comparison
    // Stable versions (no pre-release) are higher than pre-release versions
    if (!vA.isPreRelease && vB.isPreRelease) return 1;
    if (vA.isPreRelease && !vB.isPreRelease) return -1;
    if (!vA.isPreRelease && !vB.isPreRelease) return 0;

    // Both are pre-releases, compare pre-release types
    const preReleaseOrder = { alpha: 1, beta: 2, rc: 3 };
    const typeA = preReleaseOrder[vA.preReleaseType] || 0;
    const typeB = preReleaseOrder[vB.preReleaseType] || 0;

    if (typeA !== typeB) return typeA - typeB;

    // Same pre-release type, compare numbers
    return vA.preReleaseNumber - vB.preReleaseNumber;
  }

  /**
   * Gets available releases via the mos-os_get_releases script
   * @returns {Promise<Object>} Release information grouped by channels
   */
  async getReleases() {
    try {
      const command = '/usr/local/bin/mos-os_get_releases';

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      if (stderr) {
        console.warn('Get releases script stderr:', stderr);
      }

      // Read JSON file
      const releasesPath = '/var/mos/mos-update/releases.json';

      try {
        const releasesData = await fs.readFile(releasesPath, 'utf8');
        const releases = JSON.parse(releasesData);

        if (!Array.isArray(releases)) {
          throw new Error('Invalid releases data format - expected array');
        }

        // Group releases by channels based on tag_name
        const groupedReleases = {
          alpha: [],
          beta: [],
          stable: []
        };

        releases.forEach(release => {
          if (release.tag_name) {
            const tagName = release.tag_name.toLowerCase();

            if (tagName.includes('-alpha')) {
              groupedReleases.alpha.push({
                tag_name: release.tag_name,
                html_url: release.html_url
              });
            } else if (tagName.includes('-beta')) {
              groupedReleases.beta.push({
                tag_name: release.tag_name,
                html_url: release.html_url
              });
            } else {
              // Alles andere als stable behandeln (keine -alpha oder -beta Kennzeichnung)
              groupedReleases.stable.push({
                tag_name: release.tag_name,
                html_url: release.html_url
              });
            }
          }
        });

        // Sort releases by semantic version (newest first)
        Object.keys(groupedReleases).forEach(channel => {
          groupedReleases[channel].sort((a, b) => {
            return this._compareVersions(b.tag_name, a.tag_name);
          });
        });

        return groupedReleases;

      } catch (fileError) {
        throw new Error(`Failed to read or parse releases file: ${fileError.message}`);
      }

    } catch (error) {
      console.error('Get releases error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Gets the current OS information including release, CPU details and hostname
   * @returns {Promise<Object>} OS and CPU information with hostname
   */
  async getCurrentRelease() {
    try {
      const releasePath = '/etc/mos-release.json';
      const releaseData = await fs.readFile(releasePath, 'utf8');
      const release = JSON.parse(releaseData);

      // Get CPU information using systeminformation
      const si = require('systeminformation');
      const cpu = await si.cpu();

      // Get hostname from system.json
      let hostname = null;
      try {
        const systemData = await fs.readFile('/boot/config/system.json', 'utf8');
        const systemSettings = JSON.parse(systemData);
        hostname = systemSettings.hostname || null;
      } catch (hostnameError) {
        console.warn('Warning: Could not read hostname from system.json:', hostnameError.message);
      }

      // Get running kernel version
      let runningKernel = null;
      try {
        const { stdout } = await execPromise('uname -r');
        runningKernel = stdout.trim();
      } catch (kernelError) {
        console.warn('Warning: Could not get running kernel version:', kernelError.message);
      }

      // Get uptime information
      let uptimeInfo = {
        pretty: null,
        since: null
      };
      try {
        // Get uptime --pretty
        const { stdout: uptimePretty } = await execPromise('uptime --pretty');
        // Remove "up " prefix and trim whitespace
        uptimeInfo.pretty = uptimePretty.trim().replace(/^up\s+/i, '');
      } catch (prettyError) {
        console.warn('Warning: Could not get uptime --pretty:', prettyError.message);
      }
      try {
        // Get uptime --since
        const { stdout: uptimeSince } = await execPromise('uptime --since');
        uptimeInfo.since = uptimeSince.trim();
      } catch (sinceError) {
        console.warn('Warning: Could not get uptime --since:', sinceError.message);
      }

      // Process version and channel - handle nested mos object structure
      if (release.mos && typeof release.mos === 'object') {
        const originalVersion = release.mos.version || '';
        const originalChannel = release.mos.channel || '';

        // Construct full version from version + channel
        if (originalChannel) {
          release.mos.version = `${originalVersion}-${originalChannel}`;
        }

        // Clean up channel to remove suffixes (e.g., "alpha.4" -> "alpha")
        if (originalChannel) {
          release.mos.channel = originalChannel.split('.')[0];
        }

        // Add running kernel to mos object
        if (runningKernel) {
          release.mos.running_kernel = runningKernel;
        }
      } else {
        // Handle flat structure (fallback)
        const originalVersion = release.version || '';
        const originalChannel = release.channel || '';

        // Construct full version from version + channel
        if (originalChannel) {
          release.version = `${originalVersion}-${originalChannel}`;
        }

        // Clean up channel to remove suffixes (e.g., "alpha.4" -> "alpha")
        if (originalChannel) {
          release.channel = originalChannel.split('.')[0];
        }

        // Add running kernel to flat structure
        if (runningKernel) {
          if (!release.mos) release.mos = {};
          release.mos.running_kernel = runningKernel;
        }
      }

      // Combine release info with CPU info, hostname and uptime
      const osInfo = {
        hostname: hostname,
        uptime: uptimeInfo,
        cpu: {
          manufacturer: cpu.manufacturer,
          brand: cpu.brand,
          cores: cpu.cores,
          physicalCores: cpu.physicalCores
        },
        ...release
      };

      return osInfo;

    } catch (error) {
      console.error('Get current OS info error:', error.message);
      throw new Error(`Failed to read OS information: ${error.message}`);
    }
  }

  /**
   * Executes an OS update using the mos-os_update script
   * @param {string} version - Version (latest or version number like 0.0.0, 1.223.1)
   * @param {string} channel - Update channel (alpha, beta, stable)
   * @param {boolean} updateKernel - Optional, whether to update the kernel (default: true)
   * @returns {Promise<Object>} Update status
   */
  async updateOS(version, channel, updateKernel = true) {
    try {
      // Parameter validation
      if (!version || typeof version !== 'string') {
        throw new Error('Version parameter is required and must be a string');
      }

      if (!channel || !['alpha', 'beta', 'stable'].includes(channel)) {
        throw new Error('Channel must be one of: alpha, beta, stable');
      }

      // Version validation - either "latest" or version number format (with optional suffixes)
      const versionPattern = /^(latest|\d+\.\d+\.\d+.*)$/;
      if (!versionPattern.test(version)) {
        throw new Error('Version must be "latest" or start with a version number (e.g., 0.0.0, 1.223.1, 0.0.0-alpha.1)');
      }

      // Command arguments
      const args = [version, channel];

      // Add third argument only if updateKernel is true
      if (updateKernel === true) {
        args.push('update_kernel');
      }

      // Create a detached child process that executes the update immediately
      const { spawn } = require('child_process');

      // Execute the update directly in a detached process
      const child = spawn('/usr/local/bin/mos-os_update', args, {
        detached: true,
        stdio: 'ignore'
      });

      // Detach the child process from the parent, so it continues running even if the API is terminated
      child.unref();

      return {
        success: true,
        message: 'OS update initiated successfully',
        version,
        channel,
        updateKernel,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('OS update error:', error.message);
      return {
        success: false,
        error: error.message,
        version,
        channel,
        updateKernel,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Executes an OS rollback using the mos-os_update script
   * @param {boolean} kernelRollback - Optional, whether to perform a kernel rollback (default: true)
   * @returns {Promise<Object>} Rollback status
   */
  async rollbackOS(kernelRollback = true) {
    try {
      // Arguments for the command
      const args = ['rollback'];

      // "not_kernel" argument only add if kernelRollback is explicitly false
      if (kernelRollback === false) {
        args.push('not_kernel');
      }

      // Create a detached child process that executes the rollback immediately
      const { spawn } = require('child_process');

      // Execute the rollback directly in a detached process
      const child = spawn('/usr/local/bin/mos-os_update', args, {
        detached: true,
        stdio: 'ignore'
      });

      // Detach the child process from the parent, so it continues running even if the API is terminated
      child.unref();

      return {
        success: true,
        message: 'OS rollback initiated successfully',
        kernelRollback,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('OS rollback error:', error.message);
      return {
        success: false,
        error: error.message,
        kernelRollback,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Gets available kernel releases via the mos-kernel_get_releases script
   * @returns {Promise<Array>} Sorted array of kernel releases (newest first)
   */
  async getKernelReleases() {
    try {
      const command = '/usr/local/bin/mos-kernel_get_releases';

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      if (stderr) {
        console.warn('Get kernel releases script stderr:', stderr);
      }

      // Read JSON file
      const releasesPath = '/var/mos/mos-update/kernel/releases.json';

      try {
        const releasesData = await fs.readFile(releasesPath, 'utf8');
        const releases = JSON.parse(releasesData);

        if (!Array.isArray(releases)) {
          throw new Error('Invalid kernel releases data format - expected array');
        }

        // Extract and sort releases by tag_name (newest first)
        const sortedReleases = releases
          .filter(release => release.tag_name) // Only releases with tag_name
          .map(release => ({
            tag_name: release.tag_name,
            html_url: release.html_url
          }))
          .sort((a, b) => {
            return this._compareVersions(b.tag_name, a.tag_name);
          });

        return sortedReleases;

      } catch (fileError) {
        throw new Error(`Failed to read or parse kernel releases file: ${fileError.message}`);
      }

    } catch (error) {
      console.error('Get kernel releases error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Executes a kernel update using the mos-kernel_update script
   * @param {string} version - Version (recommended or version number like 6.1.0, 6.17.1-mos)
   * @returns {Promise<Object>} Update status
   */
  async updateKernel(version) {
    try {
      // Parameter validation
      if (!version || typeof version !== 'string') {
        throw new Error('Version parameter is required and must be a string');
      }

      // Version validation - either "recommended" or version number format (with optional suffixes)
      const versionPattern = /^(recommended|\d+\.\d+\.\d+.*)$/;
      if (!versionPattern.test(version)) {
        throw new Error('Version must be "recommended" or start with a version number (e.g., 6.1.0, 6.17.1-mos, 6.1.0-alpha.1)');
      }

      // Create a detached child process that executes the kernel update immediately
      const { spawn } = require('child_process');

      // Execute the kernel update directly in a detached process
      const child = spawn('/usr/local/bin/mos-kernel_update', [version], {
        detached: true,
        stdio: 'ignore'
      });

      // Detach the child process from the parent, so it continues running even if the API is terminated
      child.unref();

      return {
        success: true,
        message: 'Kernel update initiated successfully',
        version,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Kernel update error:', error.message);
      return {
        success: false,
        error: error.message,
        version,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Executes a kernel rollback using the mos-kernel_update script
   * @returns {Promise<Object>} Rollback status
   */
  async rollbackKernel() {
    try {
      // Create a detached child process that executes the kernel rollback immediately
      const { spawn } = require('child_process');

      // Execute the kernel rollback directly in a detached process
      const child = spawn('/usr/local/bin/mos-kernel_update', ['rollback'], {
        detached: true,
        stdio: 'ignore'
      });

      // Detach the child process from the parent, so it continues running even if the API is terminated
      child.unref();

      return {
        success: true,
        message: 'Kernel rollback initiated successfully',
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Kernel rollback error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Gets installed drivers from /boot/optional/drivers/
   * @returns {Promise<Object>} Grouped installed drivers by category
   */
  async getInstalledDrivers() {
    try {
      // Get current kernel version
      const { stdout: unameOutput } = await execPromise('uname -r');
      const kernelVersionTrimmed = unameOutput.trim();

      const driversBasePath = '/boot/optional/drivers';

      // Check if base directory exists
      try {
        await fs.access(driversBasePath);
      } catch (error) {
        // Directory doesn't exist, return empty object
        return {};
      }

      // Read all category directories
      const categories = await fs.readdir(driversBasePath);
      const installedDrivers = {};

      for (const category of categories) {
        const categoryPath = `${driversBasePath}/${category}`;

        // Check if it's a directory
        try {
          const stat = await fs.stat(categoryPath);
          if (!stat.isDirectory()) continue;
        } catch (error) {
          continue;
        }

        // Check if kernel version directory exists
        const kernelPath = `${categoryPath}/${kernelVersionTrimmed}`;
        try {
          await fs.access(kernelPath);
        } catch (error) {
          // Kernel version directory doesn't exist for this category
          continue;
        }

        // Read .deb files in kernel version directory
        const files = await fs.readdir(kernelPath);

        for (const file of files) {
          // Skip non-.deb files and .md5 files
          if (!file.endsWith('.deb') || file.endsWith('.deb.md5')) {
            continue;
          }

          // Remove .deb extension
          const nameWithoutDeb = file.replace('.deb', '');

          // Parse the package name
          // Format: packagename_version+suffix_architecture.deb
          const firstUnderscore = nameWithoutDeb.indexOf('_');

          if (firstUnderscore === -1) {
            continue;
          }

          const packageName = nameWithoutDeb.substring(0, firstUnderscore);
          const rest = nameWithoutDeb.substring(firstUnderscore + 1);

          // Extract version (between first _ and +)
          const plusIndex = rest.indexOf('+');
          const version = plusIndex !== -1 ? rest.substring(0, plusIndex) : rest.split('_')[0];

          // Initialize category object if it doesn't exist
          if (!installedDrivers[category]) {
            installedDrivers[category] = {};
          }

          // Initialize driver array if it doesn't exist
          if (!installedDrivers[category][packageName]) {
            installedDrivers[category][packageName] = [];
          }

          // Add version to driver array
          installedDrivers[category][packageName].push(version);
        }
      }

      return installedDrivers;

    } catch (error) {
      console.error('Get installed drivers error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Gets available driver releases via the mos-drivers_get_releases script
   * @param {string} kernelVersion - Optional kernel version, if not provided uses uname -r
   * @param {boolean} excludeInstalled - If true, filters out installed drivers
   * @returns {Promise<Object>} Grouped driver releases by category
   */
  async getDriverReleases(kernelVersion = null, excludeInstalled = false) {
    try {
      // Build command with optional kernel version
      let command = '/usr/local/bin/mos-drivers_get_releases';
      if (kernelVersion) {
        command += ` "${kernelVersion}"`;
      }

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      if (stderr) {
        console.warn('Get driver releases script stderr:', stderr);
      }

      // Get kernel version for the JSON file path
      let kernelVersionTrimmed;
      if (kernelVersion) {
        kernelVersionTrimmed = kernelVersion;
      } else {
        const { stdout: unameOutput } = await execPromise('uname -r');
        kernelVersionTrimmed = unameOutput.trim();
      }

      // Read JSON file
      const driversPath = `/var/mos/mos-drivers/drivers-${kernelVersionTrimmed}.json`;

      try {
        const driversData = await fs.readFile(driversPath, 'utf8');
        const driversJson = JSON.parse(driversData);

        // Extract assets from the JSON
        // Assuming the JSON structure contains an 'assets' array
        const assets = driversJson.assets || driversJson || [];

        if (!Array.isArray(assets)) {
          throw new Error('Invalid drivers data format - expected array or object with assets');
        }

        // Group drivers by category (first word before first dash)
        const groupedDrivers = {};

        assets.forEach(asset => {
          // Get the asset name (could be string or object with 'name' property)
          const assetName = typeof asset === 'string' ? asset : (asset.name || '');

          if (!assetName.endsWith('.deb')) {
            return; // Skip non-.deb files
          }

          // Remove .deb extension
          const nameWithoutDeb = assetName.replace('.deb', '');

          // Parse the package name
          // Format: packagename_version+suffix_architecture.deb
          // Example: dvb-digital-devices_20250910-1+mos_amd64.deb
          const firstUnderscore = nameWithoutDeb.indexOf('_');

          if (firstUnderscore === -1) {
            return; // Skip if no underscore found
          }

          const packageName = nameWithoutDeb.substring(0, firstUnderscore);
          const rest = nameWithoutDeb.substring(firstUnderscore + 1);

          // Extract version (between first _ and +)
          const plusIndex = rest.indexOf('+');
          const version = plusIndex !== -1 ? rest.substring(0, plusIndex) : rest.split('_')[0];

          // Get category (first word before first dash)
          const firstDash = packageName.indexOf('-');
          const category = firstDash !== -1 ? packageName.substring(0, firstDash) : packageName;

          // Initialize category object if it doesn't exist
          if (!groupedDrivers[category]) {
            groupedDrivers[category] = {};
          }

          // Initialize driver array if it doesn't exist
          if (!groupedDrivers[category][packageName]) {
            groupedDrivers[category][packageName] = [];
          }

          // Add version to driver array
          groupedDrivers[category][packageName].push(version);
        });

        // Filter out installed drivers if requested
        if (excludeInstalled) {
          const installedDrivers = await this.getInstalledDrivers();

          // Remove installed versions from available drivers
          for (const category in groupedDrivers) {
            if (installedDrivers[category]) {
              for (const packageName in groupedDrivers[category]) {
                if (installedDrivers[category][packageName]) {
                  // Filter out installed versions
                  groupedDrivers[category][packageName] = groupedDrivers[category][packageName].filter(
                    version => !installedDrivers[category][packageName].includes(version)
                  );

                  // Remove package entry if no versions left
                  if (groupedDrivers[category][packageName].length === 0) {
                    delete groupedDrivers[category][packageName];
                  }
                }
              }

              // Remove category if no packages left
              if (Object.keys(groupedDrivers[category]).length === 0) {
                delete groupedDrivers[category];
              }
            }
          }
        }

        return groupedDrivers;

      } catch (fileError) {
        throw new Error(`Failed to read or parse drivers file: ${fileError.message}`);
      }

    } catch (error) {
      console.error('Get driver releases error:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Downloads or upgrades drivers using the mos-driver_download script
   * @param {Object} options - Driver options
   * @param {string} [options.packagename] - Complete driver package filename (e.g., dvb-digital-devices_20250910-1+mos_amd64.deb)
   * @param {string} [options.drivername] - Driver name only (e.g., dvb-digital-devices) - requires driverversion
   * @param {string} [options.driverversion] - Driver version only (e.g., 20250910-1) - requires drivername
   * @param {string} [options.kernelVersion] - Optional desired kernel version/uname
   * @param {boolean} options.upgrade - If true, checks for driver updates
   * @returns {Promise<Object>} Driver download/upgrade status
   */
  async downloadDriver(options) {
    try {
      const { packagename, drivername, driverversion, kernelVersion, upgrade } = options;

      let command;
      let args = [];
      let finalPackageName;

      // Validate input: either upgrade=true OR packagename OR (drivername + driverversion) must be provided
      if (upgrade === true) {
        args.push('upgrade');
        command = `/usr/local/bin/mos-driver_download ${args.join(' ')}`;
      } else {
        // Option 1: Complete package name provided
        if (packagename && typeof packagename === 'string') {
          finalPackageName = packagename;
        }
        // Option 2: Driver name and version provided separately
        else if (drivername && driverversion) {
          if (typeof drivername !== 'string' || typeof driverversion !== 'string') {
            throw new Error('Driver name and driver version must be strings');
          }
          // Build complete package name: drivername_driverversion+mos_amd64.deb
          finalPackageName = `${drivername}_${driverversion}+mos_amd64.deb`;
        }
        // Error: Neither option provided
        else {
          throw new Error('Either packagename OR (drivername and driverversion) must be provided when upgrade is not true');
        }

        args.push(`"${finalPackageName}"`);

        // Add kernel version if provided
        if (kernelVersion && typeof kernelVersion === 'string') {
          args.push(`"${kernelVersion}"`);
        }

        command = `/usr/local/bin/mos-driver_download ${args.join(' ')}`;
      }

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      return {
        success: true,
        message: upgrade ? 'Driver upgrade check initiated successfully' : 'Driver download initiated successfully',
        upgrade: upgrade || false,
        packagename: finalPackageName || null,
        drivername: drivername || null,
        driverversion: driverversion || null,
        kernelVersion: kernelVersion || null,
        command,
        output: stdout,
        error: stderr || null,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Driver download error:', error.message);
      return {
        success: false,
        error: error.message,
        upgrade: options.upgrade || false,
        packagename: options.packagename || null,
        drivername: options.drivername || null,
        driverversion: options.driverversion || null,
        kernelVersion: options.kernelVersion || null,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Deletes a driver package from /boot/optional/drivers/
   * @param {Object} options - Driver options
   * @param {string} [options.packagename] - Complete driver package filename (e.g., dvb-digital-devices_20250910-1+mos_amd64.deb)
   * @param {string} [options.drivername] - Driver name only (e.g., dvb-digital-devices) - requires driverversion
   * @param {string} [options.driverversion] - Driver version only (e.g., 20250910-1) - requires drivername
   * @returns {Promise<Object>} Driver deletion status
   */
  async deleteDriver(options) {
    try {
      const { packagename, drivername, driverversion } = options;

      let finalPackageName;

      // Option 1: Complete package name provided
      if (packagename && typeof packagename === 'string') {
        finalPackageName = packagename;
      }
      // Option 2: Driver name and version provided separately
      else if (drivername && driverversion) {
        if (typeof drivername !== 'string' || typeof driverversion !== 'string') {
          throw new Error('Driver name and driver version must be strings');
        }
        // Build complete package name: drivername_driverversion+mos_amd64.deb
        finalPackageName = `${drivername}_${driverversion}+mos_amd64.deb`;
      }
      // Error: Neither option provided
      else {
        throw new Error('Either packagename OR (drivername and driverversion) must be provided');
      }

      // Parse package name to get category
      const nameWithoutDeb = finalPackageName.replace('.deb', '');
      const firstUnderscore = nameWithoutDeb.indexOf('_');

      if (firstUnderscore === -1) {
        throw new Error('Invalid package name format');
      }

      const fullDriverName = nameWithoutDeb.substring(0, firstUnderscore);

      // Get category (first word before first dash)
      const firstDash = fullDriverName.indexOf('-');
      const category = firstDash !== -1 ? fullDriverName.substring(0, firstDash) : fullDriverName;

      // Get current kernel version
      const { stdout: unameOutput } = await execPromise('uname -r');
      const kernelVersion = unameOutput.trim();

      // Build full path to driver package
      const driverPath = `/boot/optional/drivers/${category}/${kernelVersion}/${finalPackageName}`;
      const md5Path = `${driverPath}.md5`;

      // Check if driver package exists
      try {
        await fs.access(driverPath);
      } catch (error) {
        throw new Error(`Driver package not found: ${driverPath}`);
      }

      // Delete the .deb file
      await fs.unlink(driverPath);
      console.log(`Deleted driver package: ${driverPath}`);

      // Delete the .md5 file if it exists
      try {
        await fs.access(md5Path);
        await fs.unlink(md5Path);
        console.log(`Deleted MD5 file: ${md5Path}`);
      } catch (error) {
        // MD5 file doesn't exist, that's okay
        console.log(`No MD5 file found for: ${finalPackageName}`);
      }

      // Check if kernel version directory is empty
      const kernelDirPath = `/boot/optional/drivers/${category}/${kernelVersion}`;
      try {
        const filesInKernelDir = await fs.readdir(kernelDirPath);
        if (filesInKernelDir.length === 0) {
          await fs.rmdir(kernelDirPath);
          console.log(`Deleted empty kernel directory: ${kernelDirPath}`);

          // Check if category directory is empty
          const categoryDirPath = `/boot/optional/drivers/${category}`;
          try {
            const filesInCategoryDir = await fs.readdir(categoryDirPath);
            if (filesInCategoryDir.length === 0) {
              await fs.rmdir(categoryDirPath);
              console.log(`Deleted empty category directory: ${categoryDirPath}`);
            }
          } catch (error) {
            console.log(`Category directory not empty or could not be deleted: ${categoryDirPath}`);
          }
        }
      } catch (error) {
        console.log(`Kernel directory not empty or could not be deleted: ${kernelDirPath}`);
      }

      return {
        success: true,
        message: 'Driver deleted successfully',
        packagename: finalPackageName,
        drivername: drivername || null,
        driverversion: driverversion || null,
        category,
        kernelVersion,
        path: driverPath,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Driver deletion error:', error.message);
      return {
        success: false,
        error: error.message,
        packagename: options.packagename || null,
        drivername: options.drivername || null,
        driverversion: options.driverversion || null,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Executes MOS installation to disk using the mos-install script
   * @param {string} disk - Disk device (e.g., /dev/sda)
   * @param {string} filesystem - Filesystem type (vfat, ext4, btrfs, xfs)
   * @param {boolean} extra_partition - Whether to create an extra partition (default: false)
   * @returns {Promise<Object>} Installation status
   */
  async installToDisk(disk, filesystem, extra_partition = false) {
    try {
      // Parameter validation
      if (!disk || typeof disk !== 'string') {
        throw new Error('disk parameter is required and must be a string');
      }

      if (!filesystem || typeof filesystem !== 'string') {
        throw new Error('filesystem parameter is required and must be a string');
      }

      // Filesystem validation
      const validFilesystems = ['vfat', 'ext4', 'btrfs', 'xfs'];
      if (!validFilesystems.includes(filesystem)) {
        throw new Error(`filesystem must be one of: ${validFilesystems.join(', ')}`);
      }

      // Build command: bash /usr/local/bin/mos-install disk filesystem quiet extra_partition
      const command = `bash /usr/local/bin/mos-install ${disk} ${filesystem} quiet ${extra_partition}`;

      // Execute script
      const { stdout, stderr } = await execPromise(command);

      return {
        success: true,
        message: 'MOS installation to disk initiated successfully',
        disk,
        filesystem,
        extra_partition,
        command,
        output: stdout,
        error: stderr || null,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('MOS installation to disk error:', error.message);
      return {
        success: false,
        error: error.message,
        disk: disk || null,
        filesystem: filesystem || null,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Reads a file from the filesystem
   * @param {string} filePath - Path to the file to read
   * @returns {Promise<Object>} Result object with file content and metadata
   */
  async readFile(filePath) {
    try {
      // Check if file exists and read it
      const content = await fs.readFile(filePath, 'utf8');

      return {
        success: true,
        path: filePath,
        content: content,
        size: Buffer.byteLength(content, 'utf8')
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`File does not exist: ${filePath}`);
      }
      console.error('Error reading file:', error.message);
      throw error;
    }
  }

  /**
   * Edits a file on the filesystem
   * @param {string} filePath - Path to the file to edit
   * @param {string} content - New content for the file
   * @param {boolean} createBackup - Whether to create a backup file (default: false)
   * @returns {Promise<Object>} Result object with success status and optional backup path
   */
  async editFile(filePath, content, createBackup = false) {
    try {
      // Check if file exists
      try {
        await fs.access(filePath);
      } catch (error) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      // Create backup if requested
      let backupPath = null;
      if (createBackup) {
        backupPath = `${filePath}.backup`;
        const originalContent = await fs.readFile(filePath, 'utf8');
        await fs.writeFile(backupPath, originalContent, 'utf8');
      }

      // Write new content to file
      await fs.writeFile(filePath, content, 'utf8');

      return {
        success: true,
        message: 'File edited successfully',
        backupPath: backupPath
      };
    } catch (error) {
      console.error('Error editing file:', error.message);
      throw error;
    }
  }

  /**
   * Gets the dashboard layout configuration
   * @returns {Promise<Object>} The dashboard layout with left, right columns and visibility
   */
  async getDashboardLayout() {
    try {
      const data = await fs.readFile(this.dashboardPath, 'utf8');
      const layout = JSON.parse(data);

      // Validate the structure
      if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) {
        throw new Error('Dashboard layout must be an object with left, right, and visibility properties');
      }

      return layout;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Return default empty layout if file doesn't exist
        return { left: [], right: [], visibility: {} };
      }
      throw error;
    }
  }

  /**
   * Updates the dashboard layout configuration
   * @param {Object} layout - Object with left, right arrays and visibility object
   * @returns {Promise<Object>} The updated dashboard layout
   */
  async updateDashboardLayout(layout) {
    try {
      // Validate input structure
      if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) {
        throw new Error('Dashboard layout must be an object');
      }

      // Validate left array
      if (!Array.isArray(layout.left)) {
        throw new Error('Dashboard layout must have a "left" array');
      }

      // Validate right array
      if (!Array.isArray(layout.right)) {
        throw new Error('Dashboard layout must have a "right" array');
      }

      // Validate visibility object
      if (typeof layout.visibility !== 'object' || layout.visibility === null || Array.isArray(layout.visibility)) {
        throw new Error('Dashboard layout must have a "visibility" object');
      }

      // Validate cards in left and right arrays
      const validateCard = (card, position) => {
        if (!card.id || typeof card.id !== 'string') {
          throw new Error(`Each card in "${position}" must have an "id" property of type string`);
        }
        if (!card.name || typeof card.name !== 'string') {
          throw new Error(`Each card in "${position}" must have a "name" property of type string`);
        }
      };

      for (const card of layout.left) {
        validateCard(card, 'left');
      }
      for (const card of layout.right) {
        validateCard(card, 'right');
      }

      // Validate visibility values are booleans
      for (const [key, value] of Object.entries(layout.visibility)) {
        if (typeof value !== 'boolean') {
          throw new Error(`Visibility value for "${key}" must be a boolean`);
        }
      }

      // Normalize layout
      const normalizedLayout = {
        left: layout.left.map(card => ({ id: card.id, name: card.name })),
        right: layout.right.map(card => ({ id: card.id, name: card.name })),
        visibility: { ...layout.visibility }
      };

      // Write to file
      await fs.writeFile(this.dashboardPath, JSON.stringify(normalizedLayout, null, 2), 'utf8');

      return normalizedLayout;
    } catch (error) {
      console.error('Error updating dashboard layout:', error.message);
      throw error;
    }
  }

  /**
   * Filesystem Navigator - Browse directories and files with optional virtual root
   * @param {string} requestPath - Path to browse
   * @param {string} type - "directories" or "all"
   * @param {Array<string>} allowedRoots - Optional array of allowed root directories for virtual root
   * @returns {Promise<Object>} Directory listing with items and navigation info
   */
  async browseFilesystem(requestPath, type = 'directories', allowedRoots = null) {
    const normalizedPath = requestPath?.trim() || '/';

    // If allowedRoots are specified, create a virtual root
    if (allowedRoots && allowedRoots.length > 0) {
      // Special case: Virtual Root (show only specified start directories)
      if (normalizedPath === '/' || normalizedPath === '') {
        return await this._getVirtualRoot(allowedRoots, type);
      }

      // Normal path: check if within allowed roots
      const resolvedPath = path.resolve(normalizedPath);

      if (!this._isWithinAllowedRoots(resolvedPath, allowedRoots)) {
        throw new Error('Path outside allowed directories');
      }

      // Browse real directory with virtual root boundary
      return await this._browseDirectory(resolvedPath, type, allowedRoots);
    }

    // No roots specified: Browse filesystem normally (full access)
    const resolvedPath = path.resolve(normalizedPath);

    // Browse without restrictions
    return await this._browseDirectory(resolvedPath, type, null);
  }

  /**
   * Returns virtual root with configured start directories
   * @private
   */
  async _getVirtualRoot(fsNavigatorRoots, type) {
    const items = [];

    for (const rootPath of fsNavigatorRoots) {
      try {
        const stats = await fs.stat(rootPath);
        if (stats.isDirectory()) {
          items.push({
            name: path.basename(rootPath) || rootPath,
            path: rootPath,
            type: 'directory',
            displayPath: rootPath
          });
        }
      } catch (error) {
        // Root doesn't exist or isn't accessible, skip it
        console.warn(`Filesystem navigator root ${rootPath} not accessible:`, error.message);
      }
    }

    return {
      isVirtualRoot: true,
      currentPath: '/',
      parentPath: null,
      canGoUp: false,
      items: items
    };
  }

  /**
   * Browse a real directory
   * @private
   */
  async _browseDirectory(dirPath, type, fsNavigatorRoots) {
    // Check if path exists
    let stats;
    try {
      stats = await fs.stat(dirPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('Path does not exist');
      }
      throw error;
    }

    if (!stats.isDirectory()) {
      throw new Error('Path is not a directory');
    }

    // Read directory contents
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    // Filter: Only directories or all
    let filteredEntries = entries;
    if (type === 'directories') {
      filteredEntries = entries.filter(e => e.isDirectory());
    }

    // Filter out hidden files/folders (starting with .)
    filteredEntries = filteredEntries.filter(e => !e.name.startsWith('.'));

    // Create items with metadata
    const items = await Promise.all(
      filteredEntries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        let itemStats;
        try {
          itemStats = await fs.stat(fullPath);
        } catch (error) {
          // Skip items that can't be accessed
          return null;
        }

        return {
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isFile() ? itemStats.size : null,
          modified: itemStats.mtime
        };
      })
    );

    // Filter out null entries (inaccessible items)
    const validItems = items.filter(item => item !== null);

    // Sort: directories first, then alphabetically
    validItems.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    // Determine parent path (with virtual root logic)
    const parentPath = this._getParentPath(dirPath, fsNavigatorRoots);

    return {
      isVirtualRoot: false,
      currentPath: dirPath,
      parentPath: parentPath,
      canGoUp: parentPath !== null,
      items: validItems
    };
  }

  /**
   * Check if path is within allowed roots
   * @private
   */
  _isWithinAllowedRoots(checkPath, fsNavigatorRoots) {
    return fsNavigatorRoots.some(root => {
      return checkPath === root || checkPath.startsWith(root + '/');
    });
  }

  /**
   * Get parent path with optional virtual root boundary
   * @private
   */
  _getParentPath(currentPath, fsNavigatorRoots) {
    // If no roots specified, allow normal navigation
    if (!fsNavigatorRoots || fsNavigatorRoots.length === 0) {
      if (currentPath === '/') {
        return null;  // Already at root
      }
      return path.dirname(currentPath);
    }

    // With virtual root: Check if we're at a root directory
    if (fsNavigatorRoots.includes(currentPath)) {
      return '/';  // Go back to virtual root
    }

    const parent = path.dirname(currentPath);

    // Check if parent is still within allowed roots
    if (this._isWithinAllowedRoots(parent, fsNavigatorRoots)) {
      return parent;
    }

    // Parent is outside allowed roots → go back to virtual root
    return '/';
  }

  // ============================================================
  // TOKEN MANAGEMENT METHODS (github, dockerhub, etc.)
  // ============================================================

  /**
   * Encrypt token using JWT_SECRET
   * @param {string} plainToken - Plain text token
   * @returns {string} Encrypted token in format "iv:authTag:encrypted"
   * @private
   */
  _encryptToken(plainToken) {
    if (!plainToken) return '';

    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(process.env.JWT_SECRET, 'tokens-salt', 32);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv(algorithm, key, iv);
    cipher.setAAD(Buffer.from('tokens-auth'));

    let encrypted = cipher.update(plainToken, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt token using JWT_SECRET
   * @param {string} encryptedToken - Encrypted token in format "iv:authTag:encrypted"
   * @returns {string} Plain text token
   * @private
   */
  _decryptToken(encryptedToken) {
    if (!encryptedToken) return '';

    try {
      const [ivHex, authTagHex, encrypted] = encryptedToken.split(':');
      if (!ivHex || !authTagHex || !encrypted) {
        throw new Error('Invalid encrypted token format');
      }

      const algorithm = 'aes-256-gcm';
      const key = crypto.scryptSync(process.env.JWT_SECRET, 'tokens-salt', 32);
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(algorithm, key, iv);
      decipher.setAuthTag(authTag);
      decipher.setAAD(Buffer.from('tokens-auth'));

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error(`Failed to decrypt token: ${error.message}`);
    }
  }

  /**
   * Get all tokens (decrypted)
   * GET /mos/tokens
   * @returns {Promise<Object>} Object with token keys (github, dockerhub, etc.) - all decrypted
   */
  async getTokens() {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.tokensPath), { recursive: true });

      const data = await fs.readFile(this.tokensPath, 'utf8');
      const config = JSON.parse(data);

      // Decrypt all tokens before returning
      const decryptedTokens = {};
      for (const [key, encryptedValue] of Object.entries(config)) {
        decryptedTokens[key] = encryptedValue ? this._decryptToken(encryptedValue) : null;
      }

      return decryptedTokens;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return empty object
        return { github: null, dockerhub: null };
      }
      throw new Error(`Failed to get tokens: ${error.message}`);
    }
  }

  /**
   * Update tokens (encrypted) - supports partial updates
   * POST /mos/tokens
   * @param {Object} tokens - Object with token keys to update (e.g., {github: "...", dockerhub: "..."})
   * @returns {Promise<Object>} Success confirmation
   */
  async updateTokens(tokens) {
    try {
      if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
        throw new Error('Tokens must be an object');
      }

      // Ensure directory exists
      await fs.mkdir(path.dirname(this.tokensPath), { recursive: true });

      // Load existing tokens
      let existingConfig = {};
      try {
        const data = await fs.readFile(this.tokensPath, 'utf8');
        existingConfig = JSON.parse(data);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        // File doesn't exist yet, start with empty config
      }

      // Update only the provided tokens (partial update)
      for (const [key, plainValue] of Object.entries(tokens)) {
        if (plainValue === null || plainValue === undefined || plainValue === '') {
          // Allow setting to null to remove a token
          existingConfig[key] = null;
        } else {
          // Encrypt and store the token
          existingConfig[key] = this._encryptToken(plainValue);
        }
      }

      await fs.writeFile(
        this.tokensPath,
        JSON.stringify(existingConfig, null, 2),
        'utf8'
      );

      return {
        success: true,
        message: 'Tokens updated successfully',
        updated: Object.keys(tokens)
      };
    } catch (error) {
      throw new Error(`Failed to update tokens: ${error.message}`);
    }
  }
}

module.exports = new MosService();
