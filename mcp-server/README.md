# MOS MCP Server

Ein [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) Server für die MOS (MountainOS) API. Ermöglicht AI-Assistenten die Interaktion mit MOS-Systemen.

## Features

- **Vollständige API-Abdeckung**: Unterstützt alle MOS API-Endpunkte
- **70+ Tools**: Für System, Disks, Pools, Docker, LXC, VMs, Shares, etc.
- **Resources**: Schneller Zugriff auf Systeminformationen
- **Authentifizierung**: JWT-Token oder Username/Password

## Installation

```bash
cd mcp-server
npm install
```

## Konfiguration

Der MCP Server wird über Umgebungsvariablen konfiguriert:

| Variable | Beschreibung | Standard |
|----------|--------------|----------|
| `MOS_API_URL` | URL zur MOS API | `http://localhost:3000` |
| `MOS_API_TOKEN` | JWT Token (optional) | - |
| `MOS_USERNAME` | Benutzername für Login | - |
| `MOS_PASSWORD` | Passwort für Login | - |

### Authentifizierung

**Option 1: API Token**
```bash
export MOS_API_TOKEN="your-jwt-token"
```

**Option 2: Username/Password**
```bash
export MOS_USERNAME="admin"
export MOS_PASSWORD="your-password"
```

## Verwendung

### Standalone starten
```bash
npm start
```

### Mit Claude Desktop

Füge folgende Konfiguration in `claude_desktop_config.json` hinzu:

```json
{
  "mcpServers": {
    "mos": {
      "command": "node",
      "args": ["/path/to/mcp-server/src/index.js"],
      "env": {
        "MOS_API_URL": "http://your-mos-server:3000",
        "MOS_API_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

### Mit anderen MCP Clients

Der Server kommuniziert über stdio und ist mit allen MCP-kompatiblen Clients verwendbar.

## Verfügbare Tools

### Authentifizierung
- `mos_login` - MOS Login
- `mos_get_profile` - Eigenes Profil abrufen
- `mos_get_users` - Benutzer auflisten
- `mos_create_user` - Benutzer erstellen

### System
- `mos_get_system_load` - CPU, Speicher, Temperatur
- `mos_get_detailed_memory` - Detaillierte Speicherinfo
- `mos_get_detailed_system_info` - Umfassende Systeminfo
- `mos_reboot_system` - System neustarten
- `mos_shutdown_system` - System herunterfahren

### Festplatten (Disks)
- `mos_get_disks` - Alle Festplatten auflisten
- `mos_get_disk_usage` - Festplattennutzung
- `mos_get_disk_smart` - SMART-Informationen
- `mos_get_disk_power` - Power-Status
- `mos_wake_disk` - Festplatte aufwecken
- `mos_sleep_disk` - Festplatte in Standby
- `mos_get_available_filesystems` - Verfügbare Dateisysteme
- `mos_format_disk` - Festplatte formatieren

### Speicherpools (Pools)
- `mos_get_pools` - Alle Pools auflisten
- `mos_get_pool` - Pool nach ID
- `mos_get_pool_status` - Pool-Status
- `mos_get_available_pool_types` - Verfügbare Pool-Typen
- `mos_mount_pool` - Pool einbinden
- `mos_unmount_pool` - Pool aushängen
- `mos_set_pool_automount` - Automount umschalten

### Docker
- `mos_get_docker_containers` - Container auflisten
- `mos_start_docker_container` - Container starten
- `mos_stop_docker_container` - Container stoppen
- `mos_restart_docker_container` - Container neustarten
- `mos_check_docker_updates` - Auf Updates prüfen
- `mos_upgrade_docker_container` - Container aktualisieren
- `mos_remove_docker_container` - Container entfernen
- `mos_get_docker_template` - Template abrufen

### Docker Compose
- `mos_get_compose_stacks` - Stacks auflisten
- `mos_get_compose_stack` - Stack-Details
- `mos_start_compose_stack` - Stack starten
- `mos_stop_compose_stack` - Stack stoppen
- `mos_restart_compose_stack` - Stack neustarten

### LXC Container
- `mos_get_lxc_containers` - Container auflisten
- `mos_get_lxc_container` - Container-Details
- `mos_start_lxc_container` - Container starten
- `mos_stop_lxc_container` - Container stoppen
- `mos_restart_lxc_container` - Container neustarten
- `mos_kill_lxc_container` - Container beenden (force)
- `mos_freeze_lxc_container` - Container einfrieren
- `mos_unfreeze_lxc_container` - Container fortsetzen
- `mos_get_lxc_images` - Verfügbare Images

### Virtuelle Maschinen (VMs)
- `mos_get_vms` - VMs auflisten
- `mos_start_vm` - VM starten
- `mos_stop_vm` - VM stoppen (graceful)
- `mos_kill_vm` - VM beenden (force)
- `mos_restart_vm` - VM neustarten
- `mos_reset_vm` - VM zurücksetzen (hard)

### Netzwerkfreigaben (Shares)
- `mos_get_smb_shares` - SMB-Freigaben
- `mos_get_smb_share` - SMB-Freigabe nach ID
- `mos_create_smb_share` - SMB-Freigabe erstellen
- `mos_delete_smb_share` - SMB-Freigabe löschen
- `mos_get_nfs_shares` - NFS-Freigaben
- `mos_create_nfs_share` - NFS-Freigabe erstellen
- `mos_delete_nfs_share` - NFS-Freigabe löschen

### Remote Mounts
- `mos_get_remotes` - Remote-Mounts auflisten
- `mos_mount_remote` - Remote einbinden
- `mos_unmount_remote` - Remote aushängen

### Benachrichtigungen
- `mos_get_notifications` - Benachrichtigungen abrufen
- `mos_mark_notification_read` - Als gelesen markieren
- `mos_mark_all_notifications_read` - Alle als gelesen
- `mos_delete_notification` - Löschen
- `mos_delete_all_notifications` - Alle löschen

### Cron Jobs
- `mos_get_cron_jobs` - Jobs auflisten
- `mos_create_cron_job` - Job erstellen
- `mos_run_cron_job` - Job ausführen
- `mos_delete_cron_job` - Job löschen

### MOS Einstellungen
- `mos_get_docker_settings` - Docker-Einstellungen
- `mos_update_docker_settings` - Docker-Einstellungen ändern
- `mos_get_system_settings` - System-Einstellungen
- `mos_update_system_settings` - System-Einstellungen ändern
- `mos_get_network_settings` - Netzwerk-Einstellungen
- `mos_get_timezones` - Verfügbare Zeitzonen
- `mos_get_keymaps` - Verfügbare Tastaturbelegungen
- `mos_get_sensors` - Sensor-Werte

### Hub & Plugins
- `mos_get_hub_index` - Template-Index
- `mos_update_hub_repositories` - Repositories aktualisieren
- `mos_get_plugins` - Installierte Plugins
- `mos_install_plugin` - Plugin installieren
- `mos_uninstall_plugin` - Plugin deinstallieren

### iSCSI
- `mos_get_iscsi_targets` - Targets auflisten
- `mos_get_iscsi_targets_info` - Target-Statistiken
- `mos_start_iscsi_target` - Target aktivieren
- `mos_stop_iscsi_target` - Target deaktivieren

## Verfügbare Resources

| URI | Beschreibung |
|-----|--------------|
| `mos://system/info` | Aktuelle Systeminformationen |
| `mos://pools` | Alle Speicherpools |
| `mos://disks` | Alle Festplatten |
| `mos://docker/containers` | Docker-Container |
| `mos://lxc/containers` | LXC-Container |
| `mos://vm/machines` | Virtuelle Maschinen |
| `mos://notifications` | System-Benachrichtigungen |

## Beispiele

### System-Status abfragen
```
User: Was ist der aktuelle System-Status meines MOS Servers?
Assistant: [ruft mos_get_system_load auf]
```

### Docker-Container verwalten
```
User: Liste alle Docker-Container und starte "nginx" neu
Assistant: [ruft mos_get_docker_containers und mos_restart_docker_container auf]
```

### Festplatten-Gesundheit prüfen
```
User: Zeige mir die SMART-Daten von sda
Assistant: [ruft mos_get_disk_smart mit device="sda" auf]
```

## Entwicklung

```bash
# Mit Datei-Watch starten
npm run dev
```

## Lizenz

ISC
