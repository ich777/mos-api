# Pull Request: Add Comprehensive API Documentation and MCP Server

## Summary

This PR adds comprehensive API documentation and a Model Context Protocol (MCP) server for AI assistant integration with the MOS API.

## Changes

### 1. API Documentation (`DOCUMENTATION.md`)

A complete API reference covering all 17 endpoint categories:

- **Authentication** - JWT tokens, user management, admin tokens
- **System** - Load, memory, temperature, network monitoring
- **Disks** - SMART data, power management, formatting
- **Pools** - Storage pool management (btrfs, zfs, mergerfs, nonraid)
- **Docker** - Container management, updates, templates
- **Docker Compose** - Stack management
- **LXC** - Linux container management
- **VMs** - Virtual machine management (libvirt/KVM)
- **Shares** - SMB/CIFS and NFS share management
- **Remotes** - Remote mount management
- **iSCSI** - Target and initiator management
- **Cron** - Scheduled task management
- **Notifications** - System notification management
- **MOS Settings** - System configuration
- **Hub & Plugins** - Template repository and plugin management
- **Terminal** - Web terminal access
- **WebSocket** - Real-time data streams

### 2. MCP Server (`mcp-server/`)

A fully functional Model Context Protocol server enabling AI assistants (like Claude) to interact with MOS systems:

- **70+ Tools** covering all API functionality
- **7 Resources** for quick data access
- **Authentication** via JWT token or username/password
- **Example configuration** for Claude Desktop

## Files Added

```
DOCUMENTATION.md                           # Complete API documentation
mcp-server/
├── package.json                           # NPM package definition
├── README.md                              # MCP server documentation
├── claude_desktop_config.example.json     # Example Claude config
└── src/
    ├── index.js                           # MCP server entry point
    ├── api-client.js                      # MOS API client
    └── tools/
        └── index.js                       # 70+ MCP tool definitions
```

## Testing

- Documentation reviewed for accuracy against source code
- MCP server structure follows MCP SDK best practices
- All API endpoints mapped to corresponding tools

## Notes

- The MCP server requires `@modelcontextprotocol/sdk`, `axios`, and `zod` dependencies
- Node.js 18+ is required
- The documentation references the existing Swagger/OpenAPI spec at `/api-docs`

## Related

- MCP Protocol: https://modelcontextprotocol.io/
- Existing Swagger docs: `/api-docs` endpoint
