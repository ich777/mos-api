#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MosApiClient } from './api-client.js';
import { tools, handleToolCall } from './tools/index.js';

// Configuration from environment variables
const config = {
  // On MOS server: http://127.0.0.1:3000 (default)
  // External access: http://MOSIP (without /api/v1, added by client)
  baseUrl: process.env.MOS_API_URL || 'http://127.0.0.1:3000',
  token: process.env.MOS_API_TOKEN || '',
  username: process.env.MOS_USERNAME || '',
  password: process.env.MOS_PASSWORD || '',
};

// Initialize API client
const apiClient = new MosApiClient(config);

// Create MCP server
const server = new Server(
  {
    name: 'mos-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    const result = await handleToolCall(apiClient, name, args || {});
    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'mos://system/info',
        name: 'System Information',
        description: 'Current MOS system information and status',
        mimeType: 'application/json',
      },
      {
        uri: 'mos://pools',
        name: 'Storage Pools',
        description: 'List of all storage pools',
        mimeType: 'application/json',
      },
      {
        uri: 'mos://disks',
        name: 'Disk Information',
        description: 'List of all disks and partitions',
        mimeType: 'application/json',
      },
      {
        uri: 'mos://docker/containers',
        name: 'Docker Containers',
        description: 'List of Docker containers',
        mimeType: 'application/json',
      },
      {
        uri: 'mos://lxc/containers',
        name: 'LXC Containers',
        description: 'List of LXC containers',
        mimeType: 'application/json',
      },
      {
        uri: 'mos://vm/machines',
        name: 'Virtual Machines',
        description: 'List of virtual machines',
        mimeType: 'application/json',
      },
      {
        uri: 'mos://notifications',
        name: 'Notifications',
        description: 'System notifications',
        mimeType: 'application/json',
      },
    ],
  };
});

// Read resources
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  try {
    let data;
    
    switch (uri) {
      case 'mos://system/info':
        data = await apiClient.get('/system/load');
        break;
      case 'mos://pools':
        data = await apiClient.get('/pools');
        break;
      case 'mos://disks':
        data = await apiClient.get('/disks');
        break;
      case 'mos://docker/containers':
        data = await apiClient.get('/docker/mos/containers');
        break;
      case 'mos://lxc/containers':
        data = await apiClient.get('/lxc/containers');
        break;
      case 'mos://vm/machines':
        data = await apiClient.get('/vm/machines');
        break;
      case 'mos://notifications':
        data = await apiClient.get('/notifications');
        break;
      default:
        throw new Error(`Unknown resource: ${uri}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to read resource ${uri}: ${error.message}`);
  }
});

// Start server
async function main() {
  // Try to authenticate if credentials are provided
  if (config.username && config.password && !config.token) {
    try {
      await apiClient.login(config.username, config.password);
      console.error('Successfully authenticated with MOS API');
    } catch (error) {
      console.error('Warning: Failed to authenticate with MOS API:', error.message);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MOS MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
