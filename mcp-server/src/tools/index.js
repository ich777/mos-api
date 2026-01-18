/**
 * MOS MCP Server Tools Definition and Handler
 */

// Tool definitions for MCP
export const tools = [
  // ============================================
  // Authentication Tools
  // ============================================
  {
    name: 'mos_login',
    description: 'Login to MOS API and get authentication token',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Username' },
        password: { type: 'string', description: 'Password' },
      },
      required: ['username', 'password'],
    },
  },
  {
    name: 'mos_get_profile',
    description: 'Get current user profile',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_get_users',
    description: 'List all users (admin sees all, user sees only self)',
    inputSchema: {
      type: 'object',
      properties: {
        samba_user: { type: 'boolean', description: 'Filter by samba_user status' },
      },
    },
  },
  {
    name: 'mos_create_user',
    description: 'Create a new user (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Username' },
        password: { type: 'string', description: 'Password' },
        role: { type: 'string', enum: ['admin', 'user', 'samba_only'], description: 'User role' },
        samba_user: { type: 'boolean', description: 'Create SMB/CIFS user' },
      },
      required: ['username', 'password', 'role'],
    },
  },

  // ============================================
  // System Tools
  // ============================================
  {
    name: 'mos_get_system_load',
    description: 'Get system load, CPU, memory, temperature, and network utilization',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_get_detailed_memory',
    description: 'Get detailed memory information with breakdown by services',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_get_detailed_system_info',
    description: 'Get comprehensive system information (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_reboot_system',
    description: 'Reboot the MOS system (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_shutdown_system',
    description: 'Shutdown the MOS system (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },

  // ============================================
  // Disks Tools
  // ============================================
  {
    name: 'mos_get_disks',
    description: 'List all disks with partitions and power status',
    inputSchema: {
      type: 'object',
      properties: {
        performance: { type: 'boolean', description: 'Include performance metrics' },
        skipStandby: { type: 'boolean', description: 'Skip standby disks', default: true },
      },
    },
  },
  {
    name: 'mos_get_disk_usage',
    description: 'Get usage statistics for a specific disk or partition',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Device name (e.g., sda, sda1)' },
      },
      required: ['device'],
    },
  },
  {
    name: 'mos_get_disk_smart',
    description: 'Get SMART health information for a disk',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Device name (e.g., sda)' },
      },
      required: ['device'],
    },
  },
  {
    name: 'mos_get_disk_power',
    description: 'Get power status of a disk (active/standby)',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Device name' },
      },
      required: ['device'],
    },
  },
  {
    name: 'mos_wake_disk',
    description: 'Wake a disk from standby (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Device name' },
      },
      required: ['device'],
    },
  },
  {
    name: 'mos_sleep_disk',
    description: 'Put a disk to sleep/standby (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Device name' },
        mode: { type: 'string', enum: ['standby', 'sleep'], default: 'standby' },
      },
      required: ['device'],
    },
  },
  {
    name: 'mos_get_available_filesystems',
    description: 'Get list of available filesystems for formatting',
    inputSchema: {
      type: 'object',
      properties: {
        pooltype: { type: 'string', enum: ['multi', 'nonraid', 'single', 'mergerfs'], description: 'Filter by pool type' },
      },
    },
  },
  {
    name: 'mos_format_disk',
    description: 'Format a disk with specified filesystem (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Device path (e.g., /dev/sdb)' },
        filesystem: { type: 'string', enum: ['ext4', 'xfs', 'btrfs', 'ntfs', 'fat32', 'exfat', 'vfat', 'zfs'], description: 'Target filesystem' },
        partition: { type: 'boolean', description: 'Create partition table', default: true },
        wipeExisting: { type: 'boolean', description: 'Wipe existing data', default: true },
      },
      required: ['device', 'filesystem'],
    },
  },

  // ============================================
  // Pools Tools
  // ============================================
  {
    name: 'mos_get_pools',
    description: 'List all storage pools',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by pool type' },
        exclude_type: { type: 'string', description: 'Exclude pool type' },
        includeMetrics: { type: 'boolean', description: 'Include performance/temperature data' },
      },
    },
  },
  {
    name: 'mos_get_pool',
    description: 'Get a specific pool by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Pool ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mos_get_pool_status',
    description: 'Get the status of a pool',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Pool ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mos_get_available_pool_types',
    description: 'Get available pool types',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_mount_pool',
    description: 'Mount a storage pool (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Pool ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mos_unmount_pool',
    description: 'Unmount a storage pool (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Pool ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mos_set_pool_automount',
    description: 'Enable or disable automount for a pool (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Pool ID' },
        enabled: { type: 'boolean', description: 'Enable automount' },
      },
      required: ['id', 'enabled'],
    },
  },

  // ============================================
  // Docker Tools
  // ============================================
  {
    name: 'mos_get_docker_containers',
    description: 'List all Docker containers with update status',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_start_docker_container',
    description: 'Start a Docker container (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_stop_docker_container',
    description: 'Stop a Docker container (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_restart_docker_container',
    description: 'Restart a Docker container (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_check_docker_updates',
    description: 'Check for Docker container updates (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name (optional, null for all)' },
      },
    },
  },
  {
    name: 'mos_upgrade_docker_container',
    description: 'Upgrade a Docker container (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name (optional, null for all)' },
        force_update: { type: 'boolean', description: 'Force update even if no new version', default: false },
      },
    },
  },
  {
    name: 'mos_remove_docker_container',
    description: 'Remove a Docker container and its template (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_get_docker_template',
    description: 'Get a Docker container template (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },

  // ============================================
  // Docker Compose Tools
  // ============================================
  {
    name: 'mos_get_compose_stacks',
    description: 'List all Docker Compose stacks (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_get_compose_stack',
    description: 'Get a specific Docker Compose stack (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stack name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_start_compose_stack',
    description: 'Start a Docker Compose stack (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stack name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_stop_compose_stack',
    description: 'Stop a Docker Compose stack (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stack name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_restart_compose_stack',
    description: 'Restart a Docker Compose stack (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stack name' },
      },
      required: ['name'],
    },
  },

  // ============================================
  // LXC Tools
  // ============================================
  {
    name: 'mos_get_lxc_containers',
    description: 'List all LXC containers (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_get_lxc_container',
    description: 'Get details of a specific LXC container (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_start_lxc_container',
    description: 'Start an LXC container (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_stop_lxc_container',
    description: 'Stop an LXC container (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_restart_lxc_container',
    description: 'Restart an LXC container (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_kill_lxc_container',
    description: 'Forcefully stop an LXC container (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_freeze_lxc_container',
    description: 'Freeze/pause an LXC container (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_unfreeze_lxc_container',
    description: 'Unfreeze/resume an LXC container (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Container name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_get_lxc_images',
    description: 'Get available LXC images (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },

  // ============================================
  // VM Tools
  // ============================================
  {
    name: 'mos_get_vms',
    description: 'List all virtual machines (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_start_vm',
    description: 'Start a virtual machine (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'VM name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_stop_vm',
    description: 'Stop a virtual machine gracefully (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'VM name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_kill_vm',
    description: 'Force stop a virtual machine (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'VM name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_restart_vm',
    description: 'Restart a virtual machine gracefully (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'VM name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mos_reset_vm',
    description: 'Hard reset a virtual machine (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'VM name' },
      },
      required: ['name'],
    },
  },

  // ============================================
  // Shares Tools
  // ============================================
  {
    name: 'mos_get_smb_shares',
    description: 'List all SMB/CIFS shares (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_get_smb_share',
    description: 'Get a specific SMB share (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Share ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mos_create_smb_share',
    description: 'Create an SMB share (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        shareName: { type: 'string', description: 'Share name' },
        poolName: { type: 'string', description: 'Pool name' },
        subPath: { type: 'string', description: 'Subdirectory path' },
        enabled: { type: 'boolean', default: true },
        read_only: { type: 'boolean', default: false },
        guest_ok: { type: 'boolean', default: false },
        browseable: { type: 'boolean', default: true },
        write_list: { type: 'array', items: { type: 'string' } },
        valid_users: { type: 'array', items: { type: 'string' } },
      },
      required: ['shareName'],
    },
  },
  {
    name: 'mos_delete_smb_share',
    description: 'Delete an SMB share (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Share ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mos_get_nfs_shares',
    description: 'List all NFS shares (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_create_nfs_share',
    description: 'Create an NFS share (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        shareName: { type: 'string', description: 'Share name' },
        poolName: { type: 'string', description: 'Pool name' },
        subPath: { type: 'string', description: 'Subdirectory path' },
        source: { type: 'string', description: 'Network address/range', default: '10.0.0.0/24' },
        enabled: { type: 'boolean', default: true },
        read_only: { type: 'boolean', default: false },
      },
      required: ['shareName'],
    },
  },
  {
    name: 'mos_delete_nfs_share',
    description: 'Delete an NFS share (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Share ID' },
      },
      required: ['id'],
    },
  },

  // ============================================
  // Remotes Tools
  // ============================================
  {
    name: 'mos_get_remotes',
    description: 'List all remote mounts (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_mount_remote',
    description: 'Mount a remote share (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Remote ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mos_unmount_remote',
    description: 'Unmount a remote share (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Remote ID' },
      },
      required: ['id'],
    },
  },

  // ============================================
  // Notifications Tools
  // ============================================
  {
    name: 'mos_get_notifications',
    description: 'Get system notifications (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        read: { type: 'boolean', description: 'Filter by read status' },
        limit: { type: 'integer', description: 'Limit number of results' },
        order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order' },
      },
    },
  },
  {
    name: 'mos_mark_notification_read',
    description: 'Mark a notification as read (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Notification ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mos_mark_all_notifications_read',
    description: 'Mark all notifications as read (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_delete_notification',
    description: 'Delete a notification (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Notification ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mos_delete_all_notifications',
    description: 'Delete all notifications (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },

  // ============================================
  // Cron Tools
  // ============================================
  {
    name: 'mos_get_cron_jobs',
    description: 'List all cron jobs',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_create_cron_job',
    description: 'Create a new cron job (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job name' },
        schedule: { type: 'string', description: 'Cron schedule (e.g., "0 2 * * *")' },
        command: { type: 'string', description: 'Command to execute' },
        enabled: { type: 'boolean', default: true },
        script: { type: 'string', description: 'Script content (optional)' },
      },
      required: ['name', 'schedule'],
    },
  },
  {
    name: 'mos_run_cron_job',
    description: 'Run a cron job immediately (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cron job ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mos_delete_cron_job',
    description: 'Delete a cron job (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cron job ID' },
      },
      required: ['id'],
    },
  },

  // ============================================
  // MOS Settings Tools
  // ============================================
  {
    name: 'mos_get_docker_settings',
    description: 'Get Docker service settings (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_update_docker_settings',
    description: 'Update Docker service settings (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Enable Docker service' },
        directory: { type: 'string', description: 'Docker data directory' },
        appdata: { type: 'string', description: 'Docker appdata directory' },
      },
    },
  },
  {
    name: 'mos_get_system_settings',
    description: 'Get system settings (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_update_system_settings',
    description: 'Update system settings (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        hostname: { type: 'string', description: 'System hostname' },
        timezone: { type: 'string', description: 'System timezone' },
        global_spindown: { type: 'boolean', description: 'Enable global disk spindown' },
      },
    },
  },
  {
    name: 'mos_get_network_settings',
    description: 'Get network settings (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_get_timezones',
    description: 'Get available timezones',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_get_keymaps',
    description: 'Get available keyboard layouts',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_get_sensors',
    description: 'Get sensor readings (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },

  // ============================================
  // Hub & Plugins Tools
  // ============================================
  {
    name: 'mos_get_hub_index',
    description: 'Get template index from Hub repositories (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term' },
        category: { type: 'string', description: 'Filter by category' },
        type: { type: 'string', enum: ['docker', 'compose', 'plugin'], description: 'Filter by type' },
        limit: { type: 'integer', description: 'Max results' },
      },
    },
  },
  {
    name: 'mos_update_hub_repositories',
    description: 'Update/refresh Hub repositories (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_get_plugins',
    description: 'List installed plugins (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_install_plugin',
    description: 'Install a plugin from Hub (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Path to Hub plugin template' },
        tag: { type: 'string', description: 'Release tag to install' },
      },
      required: ['template', 'tag'],
    },
  },
  {
    name: 'mos_uninstall_plugin',
    description: 'Uninstall a plugin (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Plugin name' },
      },
      required: ['name'],
    },
  },

  // ============================================
  // iSCSI Tools
  // ============================================
  {
    name: 'mos_get_iscsi_targets',
    description: 'List all iSCSI targets (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_get_iscsi_targets_info',
    description: 'Get iSCSI targets statistics (admin only)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mos_start_iscsi_target',
    description: 'Activate an iSCSI target (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Target ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mos_stop_iscsi_target',
    description: 'Deactivate an iSCSI target (admin only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Target ID' },
      },
      required: ['id'],
    },
  },
];

/**
 * Handle tool calls from MCP clients
 */
export async function handleToolCall(apiClient, toolName, args) {
  switch (toolName) {
    // Authentication
    case 'mos_login':
      return apiClient.login(args.username, args.password);
    case 'mos_get_profile':
      return apiClient.getProfile();
    case 'mos_get_users':
      return apiClient.getUsers(args);
    case 'mos_create_user':
      return apiClient.createUser(args);

    // System
    case 'mos_get_system_load':
      return apiClient.getSystemLoad();
    case 'mos_get_detailed_memory':
      return apiClient.getDetailedMemory();
    case 'mos_get_detailed_system_info':
      return apiClient.getDetailedSystemInfo();
    case 'mos_reboot_system':
      return apiClient.rebootSystem();
    case 'mos_shutdown_system':
      return apiClient.shutdownSystem();

    // Disks
    case 'mos_get_disks':
      return apiClient.getDisks(args);
    case 'mos_get_disk_usage':
      return apiClient.getDiskUsage(args.device);
    case 'mos_get_disk_smart':
      return apiClient.getDiskSmart(args.device);
    case 'mos_get_disk_power':
      return apiClient.getDiskPower(args.device);
    case 'mos_wake_disk':
      return apiClient.wakeDisk(args.device);
    case 'mos_sleep_disk':
      return apiClient.sleepDisk(args.device, args.mode);
    case 'mos_get_available_filesystems':
      return apiClient.getAvailableFilesystems(args.pooltype);
    case 'mos_format_disk':
      return apiClient.formatDisk(args.device, args.filesystem, args);

    // Pools
    case 'mos_get_pools':
      return apiClient.getPools(args);
    case 'mos_get_pool':
      return apiClient.getPool(args.id);
    case 'mos_get_pool_status':
      return apiClient.getPoolStatus(args.id);
    case 'mos_get_available_pool_types':
      return apiClient.getAvailablePoolTypes();
    case 'mos_mount_pool':
      return apiClient.mountPool(args.id);
    case 'mos_unmount_pool':
      return apiClient.unmountPool(args.id);
    case 'mos_set_pool_automount':
      return apiClient.setPoolAutomount(args.id, args.enabled);

    // Docker
    case 'mos_get_docker_containers':
      return apiClient.getDockerContainers();
    case 'mos_start_docker_container':
      return apiClient.startDockerContainer(args.name);
    case 'mos_stop_docker_container':
      return apiClient.stopDockerContainer(args.name);
    case 'mos_restart_docker_container':
      return apiClient.restartDockerContainer(args.name);
    case 'mos_check_docker_updates':
      return apiClient.checkDockerUpdates(args.name);
    case 'mos_upgrade_docker_container':
      return apiClient.upgradeDockerContainer(args.name, args.force_update);
    case 'mos_remove_docker_container':
      return apiClient.removeDockerContainer(args.name);
    case 'mos_get_docker_template':
      return apiClient.getDockerTemplate(args.name);

    // Docker Compose
    case 'mos_get_compose_stacks':
      return apiClient.getComposeStacks();
    case 'mos_get_compose_stack':
      return apiClient.getComposeStack(args.name);
    case 'mos_start_compose_stack':
      return apiClient.startComposeStack(args.name);
    case 'mos_stop_compose_stack':
      return apiClient.stopComposeStack(args.name);
    case 'mos_restart_compose_stack':
      return apiClient.restartComposeStack(args.name);

    // LXC
    case 'mos_get_lxc_containers':
      return apiClient.getLxcContainers();
    case 'mos_get_lxc_container':
      return apiClient.getLxcContainer(args.name);
    case 'mos_start_lxc_container':
      return apiClient.startLxcContainer(args.name);
    case 'mos_stop_lxc_container':
      return apiClient.stopLxcContainer(args.name);
    case 'mos_restart_lxc_container':
      return apiClient.restartLxcContainer(args.name);
    case 'mos_kill_lxc_container':
      return apiClient.killLxcContainer(args.name);
    case 'mos_freeze_lxc_container':
      return apiClient.freezeLxcContainer(args.name);
    case 'mos_unfreeze_lxc_container':
      return apiClient.unfreezeLxcContainer(args.name);
    case 'mos_get_lxc_images':
      return apiClient.getLxcImages();

    // VMs
    case 'mos_get_vms':
      return apiClient.getVMs();
    case 'mos_start_vm':
      return apiClient.startVM(args.name);
    case 'mos_stop_vm':
      return apiClient.stopVM(args.name);
    case 'mos_kill_vm':
      return apiClient.killVM(args.name);
    case 'mos_restart_vm':
      return apiClient.restartVM(args.name);
    case 'mos_reset_vm':
      return apiClient.resetVM(args.name);

    // Shares
    case 'mos_get_smb_shares':
      return apiClient.getSmbShares();
    case 'mos_get_smb_share':
      return apiClient.getSmbShare(args.id);
    case 'mos_create_smb_share':
      return apiClient.createSmbShare(args);
    case 'mos_delete_smb_share':
      return apiClient.deleteSmbShare(args.id);
    case 'mos_get_nfs_shares':
      return apiClient.getNfsShares();
    case 'mos_create_nfs_share':
      return apiClient.createNfsShare(args);
    case 'mos_delete_nfs_share':
      return apiClient.deleteNfsShare(args.id);

    // Remotes
    case 'mos_get_remotes':
      return apiClient.getRemotes();
    case 'mos_mount_remote':
      return apiClient.mountRemote(args.id);
    case 'mos_unmount_remote':
      return apiClient.unmountRemote(args.id);

    // Notifications
    case 'mos_get_notifications':
      return apiClient.getNotifications(args);
    case 'mos_mark_notification_read':
      return apiClient.markNotificationRead(args.id);
    case 'mos_mark_all_notifications_read':
      return apiClient.markAllNotificationsRead();
    case 'mos_delete_notification':
      return apiClient.deleteNotification(args.id);
    case 'mos_delete_all_notifications':
      return apiClient.deleteAllNotifications();

    // Cron
    case 'mos_get_cron_jobs':
      return apiClient.getCronJobs();
    case 'mos_create_cron_job':
      return apiClient.createCronJob(args);
    case 'mos_run_cron_job':
      return apiClient.runCronJob(args.id);
    case 'mos_delete_cron_job':
      return apiClient.deleteCronJob(args.id);

    // MOS Settings
    case 'mos_get_docker_settings':
      return apiClient.getDockerSettings();
    case 'mos_update_docker_settings':
      return apiClient.updateDockerSettings(args);
    case 'mos_get_system_settings':
      return apiClient.getSystemSettings();
    case 'mos_update_system_settings':
      return apiClient.updateSystemSettings(args);
    case 'mos_get_network_settings':
      return apiClient.getNetworkSettings();
    case 'mos_get_timezones':
      return apiClient.getTimezones();
    case 'mos_get_keymaps':
      return apiClient.getKeymaps();
    case 'mos_get_sensors':
      return apiClient.getSensors();

    // Hub & Plugins
    case 'mos_get_hub_index':
      return apiClient.getHubIndex(args);
    case 'mos_update_hub_repositories':
      return apiClient.updateHubRepositories();
    case 'mos_get_plugins':
      return apiClient.getPlugins();
    case 'mos_install_plugin':
      return apiClient.installPlugin(args.template, args.tag);
    case 'mos_uninstall_plugin':
      return apiClient.uninstallPlugin(args.name);

    // iSCSI
    case 'mos_get_iscsi_targets':
      return apiClient.getIscsiTargets();
    case 'mos_get_iscsi_targets_info':
      return apiClient.getIscsiTargetsInfo();
    case 'mos_start_iscsi_target':
      return apiClient.startIscsiTarget(args.id);
    case 'mos_stop_iscsi_target':
      return apiClient.stopIscsiTarget(args.id);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
