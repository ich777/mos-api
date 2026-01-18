import axios from 'axios';

/**
 * MOS API Client for MCP Server
 */
export class MosApiClient {
  constructor(config) {
    // On MOS server: http://127.0.0.1:3000
    // External access: http://MOSIP/api/v1/
    this.baseUrl = config.baseUrl || 'http://127.0.0.1:3000';
    this.token = config.token || null;
    
    this.client = axios.create({
      baseURL: `${this.baseUrl}/api/v1`,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add auth token to requests
    this.client.interceptors.request.use((config) => {
      if (this.token) {
        config.headers.Authorization = `Bearer ${this.token}`;
      }
      return config;
    });

    // Handle errors
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response) {
          const message = error.response.data?.error || error.response.statusText;
          throw new Error(`API Error (${error.response.status}): ${message}`);
        } else if (error.request) {
          throw new Error('No response from MOS API server');
        } else {
          throw new Error(`Request error: ${error.message}`);
        }
      }
    );
  }

  /**
   * Login to MOS API
   */
  async login(username, password) {
    const response = await this.client.post('/auth/login', { username, password });
    this.token = response.data.token;
    return response.data;
  }

  /**
   * Set authentication token
   */
  setToken(token) {
    this.token = token;
  }

  /**
   * GET request
   */
  async get(endpoint, params = {}) {
    const response = await this.client.get(endpoint, { params });
    return response.data;
  }

  /**
   * POST request
   */
  async post(endpoint, data = {}) {
    const response = await this.client.post(endpoint, data);
    return response.data;
  }

  /**
   * PUT request
   */
  async put(endpoint, data = {}) {
    const response = await this.client.put(endpoint, data);
    return response.data;
  }

  /**
   * DELETE request
   */
  async delete(endpoint, data = {}) {
    const response = await this.client.delete(endpoint, { data });
    return response.data;
  }

  // ============================================
  // Authentication Methods
  // ============================================

  async getFirstSetup() {
    return this.get('/auth/firstsetup');
  }

  async getProfile() {
    return this.get('/auth/profile');
  }

  async getUsers(filters = {}) {
    return this.get('/auth/users', filters);
  }

  async createUser(userData) {
    return this.post('/auth/users', userData);
  }

  async updateUser(id, updates) {
    return this.put(`/auth/users/${id}`, updates);
  }

  async deleteUser(id) {
    return this.delete(`/auth/users/${id}`);
  }

  async logout() {
    return this.post('/auth/logout');
  }

  // ============================================
  // System Methods
  // ============================================

  async getSystemLoad() {
    return this.get('/system/load');
  }

  async getDetailedMemory() {
    return this.get('/system/memory');
  }

  async getDetailedSystemInfo() {
    return this.get('/system/detailed');
  }

  async rebootSystem() {
    return this.post('/system/reboot');
  }

  async shutdownSystem() {
    return this.post('/system/shutdown');
  }

  // ============================================
  // Disks Methods
  // ============================================

  async getDisks(options = {}) {
    return this.get('/disks', options);
  }

  async getDiskUsage(device) {
    return this.get(`/disks/${device}/usage`);
  }

  async getDiskPower(device) {
    return this.get(`/disks/${device}/power`);
  }

  async getDiskIOStats(device) {
    return this.get(`/disks/${device}/iostats`);
  }

  async getDiskSmart(device) {
    return this.get(`/disks/${device}/smart`);
  }

  async getAvailableFilesystems(pooltype) {
    return this.get('/disks/availablefilesystems', { pooltype });
  }

  async wakeDisk(device) {
    return this.post(`/disks/${device}/wake`);
  }

  async sleepDisk(device, mode = 'standby') {
    return this.post(`/disks/${device}/sleep`, { mode });
  }

  async formatDisk(device, filesystem, options = {}) {
    return this.post('/disks/format', { device, filesystem, ...options });
  }

  // ============================================
  // Pools Methods
  // ============================================

  async getPools(filters = {}) {
    return this.get('/pools', filters);
  }

  async getPool(id) {
    return this.get(`/pools/${id}`);
  }

  async getPoolStatus(id) {
    return this.get(`/pools/${id}/status`);
  }

  async getAvailablePoolTypes() {
    return this.get('/pools/availablepooltypes');
  }

  async createPool(poolData) {
    return this.post('/pools', poolData);
  }

  async updatePool(id, updates) {
    return this.put(`/pools/${id}`, updates);
  }

  async deletePool(id) {
    return this.delete(`/pools/${id}`);
  }

  async mountPool(id) {
    return this.post(`/pools/${id}/mount`);
  }

  async unmountPool(id) {
    return this.post(`/pools/${id}/unmount`);
  }

  async setPoolAutomount(id, enabled) {
    return this.post(`/pools/${id}/automount`, { enabled });
  }

  // ============================================
  // Docker Methods
  // ============================================

  async getDockerContainers() {
    return this.get('/docker/mos/containers');
  }

  async createDockerContainer(template) {
    return this.post('/docker/mos/create', template);
  }

  async removeDockerContainer(name) {
    return this.delete('/docker/mos/remove', { name });
  }

  async startDockerContainer(name) {
    return this.post('/docker/mos/start', { name });
  }

  async stopDockerContainer(name) {
    return this.post('/docker/mos/stop', { name });
  }

  async restartDockerContainer(name) {
    return this.post('/docker/mos/restart', { name });
  }

  async checkDockerUpdates(name = null) {
    return this.post('/docker/mos/update_check', { name });
  }

  async upgradeDockerContainer(name = null, forceUpdate = false) {
    return this.post('/docker/mos/upgrade', { name, force_update: forceUpdate });
  }

  async getDockerTemplate(name) {
    return this.get(`/docker/mos/templates/${name}`);
  }

  async updateDockerTemplate(name, template) {
    return this.put(`/docker/mos/templates/${name}`, template);
  }

  // ============================================
  // Docker Compose Methods
  // ============================================

  async getComposeStacks() {
    return this.get('/docker/mos/compose/stacks');
  }

  async getComposeStack(name) {
    return this.get(`/docker/mos/compose/stacks/${name}`);
  }

  async createComposeStack(stackData) {
    return this.post('/docker/mos/compose/stacks', stackData);
  }

  async updateComposeStack(name, stackData) {
    return this.put(`/docker/mos/compose/stacks/${name}`, stackData);
  }

  async deleteComposeStack(name) {
    return this.delete(`/docker/mos/compose/stacks/${name}`);
  }

  async startComposeStack(name) {
    return this.post(`/docker/mos/compose/stacks/${name}/start`);
  }

  async stopComposeStack(name) {
    return this.post(`/docker/mos/compose/stacks/${name}/stop`);
  }

  async restartComposeStack(name) {
    return this.post(`/docker/mos/compose/stacks/${name}/restart`);
  }

  // ============================================
  // LXC Methods
  // ============================================

  async getLxcContainers() {
    return this.get('/lxc/containers');
  }

  async getLxcContainer(name) {
    return this.get(`/lxc/containers/${name}`);
  }

  async createLxcContainer(containerData) {
    return this.post('/lxc/containers', containerData);
  }

  async deleteLxcContainer(name) {
    return this.delete(`/lxc/containers/${name}`);
  }

  async startLxcContainer(name) {
    return this.post(`/lxc/containers/${name}/start`);
  }

  async stopLxcContainer(name) {
    return this.post(`/lxc/containers/${name}/stop`);
  }

  async restartLxcContainer(name) {
    return this.post(`/lxc/containers/${name}/restart`);
  }

  async killLxcContainer(name) {
    return this.post(`/lxc/containers/${name}/kill`);
  }

  async freezeLxcContainer(name) {
    return this.post(`/lxc/containers/${name}/freeze`);
  }

  async unfreezeLxcContainer(name) {
    return this.post(`/lxc/containers/${name}/unfreeze`);
  }

  async getLxcImages() {
    return this.get('/lxc/images');
  }

  // ============================================
  // VM Methods
  // ============================================

  async getVMs() {
    return this.get('/vm/machines');
  }

  async getVM(name) {
    return this.get(`/vm/machines/${name}`);
  }

  async startVM(name) {
    return this.post(`/vm/machines/${name}/start`);
  }

  async stopVM(name) {
    return this.post(`/vm/machines/${name}/stop`);
  }

  async killVM(name) {
    return this.post(`/vm/machines/${name}/kill`);
  }

  async restartVM(name) {
    return this.post(`/vm/machines/${name}/restart`);
  }

  async resetVM(name) {
    return this.post(`/vm/machines/${name}/reset`);
  }

  async suspendVM(name) {
    return this.post(`/vm/machines/${name}/suspend`);
  }

  async resumeVM(name) {
    return this.post(`/vm/machines/${name}/resume`);
  }

  // ============================================
  // Shares Methods
  // ============================================

  async getSmbShares() {
    return this.get('/shares/smb');
  }

  async getSmbShare(id) {
    return this.get(`/shares/smb/${id}`);
  }

  async createSmbShare(shareData) {
    return this.post('/shares/smb', shareData);
  }

  async updateSmbShare(id, updates) {
    return this.put(`/shares/smb/${id}`, updates);
  }

  async deleteSmbShare(id) {
    return this.delete(`/shares/smb/${id}`);
  }

  async getNfsShares() {
    return this.get('/shares/nfs');
  }

  async getNfsShare(id) {
    return this.get(`/shares/nfs/${id}`);
  }

  async createNfsShare(shareData) {
    return this.post('/shares/nfs', shareData);
  }

  async updateNfsShare(id, updates) {
    return this.put(`/shares/nfs/${id}`, updates);
  }

  async deleteNfsShare(id) {
    return this.delete(`/shares/nfs/${id}`);
  }

  // ============================================
  // Remotes Methods
  // ============================================

  async getRemotes() {
    return this.get('/remotes');
  }

  async getRemote(id) {
    return this.get(`/remotes/${id}`);
  }

  async createRemote(remoteData) {
    return this.post('/remotes', remoteData);
  }

  async updateRemote(id, updates) {
    return this.put(`/remotes/${id}`, updates);
  }

  async deleteRemote(id) {
    return this.delete(`/remotes/${id}`);
  }

  async mountRemote(id) {
    return this.post(`/remotes/${id}/mount`);
  }

  async unmountRemote(id) {
    return this.post(`/remotes/${id}/unmount`);
  }

  async testRemoteConnection(remoteData) {
    return this.post('/remotes/test', remoteData);
  }

  // ============================================
  // iSCSI Methods
  // ============================================

  async getIscsiTargets() {
    return this.get('/iscsi/targets');
  }

  async getIscsiTargetsInfo() {
    return this.get('/iscsi/targets/info');
  }

  async getIscsiTarget(id) {
    return this.get(`/iscsi/targets/${id}`);
  }

  async createIscsiTarget(targetData) {
    return this.post('/iscsi/targets', targetData);
  }

  async updateIscsiTarget(id, updates) {
    return this.put(`/iscsi/targets/${id}`, updates);
  }

  async deleteIscsiTarget(id) {
    return this.delete(`/iscsi/targets/${id}`);
  }

  async startIscsiTarget(id) {
    return this.post(`/iscsi/targets/${id}/start`);
  }

  async stopIscsiTarget(id) {
    return this.post(`/iscsi/targets/${id}/stop`);
  }

  // ============================================
  // Cron Methods
  // ============================================

  async getCronJobs() {
    return this.get('/cron');
  }

  async getCronJob(id) {
    return this.get(`/cron/${id}`);
  }

  async createCronJob(jobData) {
    return this.post('/cron', jobData);
  }

  async updateCronJob(id, updates) {
    return this.put(`/cron/${id}`, updates);
  }

  async deleteCronJob(id) {
    return this.delete(`/cron/${id}`);
  }

  async runCronJob(id) {
    return this.post(`/cron/${id}/run`);
  }

  async getCronScripts() {
    return this.get('/cron/scripts');
  }

  // ============================================
  // Notifications Methods
  // ============================================

  async getNotifications(options = {}) {
    return this.get('/notifications', options);
  }

  async getNotificationStats() {
    return this.get('/notifications/stats');
  }

  async deleteNotification(id) {
    return this.delete(`/notifications/${id}`);
  }

  async deleteAllNotifications() {
    return this.delete('/notifications');
  }

  async markNotificationRead(id) {
    return this.post(`/notifications/${id}/read`);
  }

  async markAllNotificationsRead() {
    return this.post('/notifications/read-all');
  }

  // ============================================
  // MOS Settings Methods
  // ============================================

  async getDockerSettings() {
    return this.get('/mos/settings/docker');
  }

  async updateDockerSettings(settings) {
    return this.post('/mos/settings/docker', settings);
  }

  async getLxcSettings() {
    return this.get('/mos/settings/lxc');
  }

  async updateLxcSettings(settings) {
    return this.post('/mos/settings/lxc', settings);
  }

  async getVmSettings() {
    return this.get('/mos/settings/vm');
  }

  async updateVmSettings(settings) {
    return this.post('/mos/settings/vm', settings);
  }

  async getNetworkSettings() {
    return this.get('/mos/settings/network');
  }

  async updateNetworkSettings(settings) {
    return this.post('/mos/settings/network', settings);
  }

  async getSystemSettings() {
    return this.get('/mos/settings/system');
  }

  async updateSystemSettings(settings) {
    return this.post('/mos/settings/system', settings);
  }

  async getKeymaps() {
    return this.get('/mos/keymaps');
  }

  async getTimezones() {
    return this.get('/mos/timezones');
  }

  async getSensors() {
    return this.get('/mos/sensors');
  }

  async getAvailableSensors() {
    return this.get('/mos/sensors/available');
  }

  // ============================================
  // Hub Methods
  // ============================================

  async getHubSettings() {
    return this.get('/mos/hub/settings');
  }

  async updateHubSettings(settings) {
    return this.post('/mos/hub/settings', settings);
  }

  async getHubRepositories() {
    return this.get('/mos/hub/repositories');
  }

  async setHubRepositories(repositories) {
    return this.post('/mos/hub/repositories', repositories);
  }

  async updateHubRepositories() {
    return this.post('/mos/hub/update');
  }

  async getHubIndex(options = {}) {
    return this.get('/mos/hub/index', options);
  }

  async getHubCategories() {
    return this.get('/mos/hub/categories');
  }

  // ============================================
  // Plugins Methods
  // ============================================

  async getPlugins() {
    return this.get('/mos/plugins');
  }

  async queryPlugin(command, args = [], options = {}) {
    return this.post('/mos/plugins/query', { command, args, ...options });
  }

  async getPluginReleases(repository, refresh = false) {
    return this.post('/mos/plugins/releases', { repository, refresh });
  }

  async installPlugin(template, tag) {
    return this.post('/mos/plugins/install', { template, tag });
  }

  async uninstallPlugin(name) {
    return this.post('/mos/plugins/uninstall', { name });
  }

  // ============================================
  // Terminal Methods
  // ============================================

  async getTerminalSessions() {
    return this.get('/terminal/sessions');
  }

  async createTerminalSession() {
    return this.post('/terminal/sessions');
  }

  async deleteTerminalSession(id) {
    return this.delete(`/terminal/sessions/${id}`);
  }
}
