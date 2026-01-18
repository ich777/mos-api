# MOS API - Vollständige Dokumentation

## Übersicht

Die **MOS API** (MountainOS API) ist eine umfassende System-Management-API für das MOS Betriebssystem. Sie bietet RESTful-Endpunkte für die Verwaltung von Speicher, Containern, virtuellen Maschinen, Netzwerkfreigaben und Systemkonfiguration.

**Basis-URL:** `http://<server>:3000/api/v1`  
**Dokumentation:** `http://<server>:3000/api-docs` (Swagger UI)

---

## Inhaltsverzeichnis

1. [Authentifizierung](#1-authentifizierung)
2. [System](#2-system)
3. [Disks (Festplatten)](#3-disks-festplatten)
4. [Pools (Speicherpools)](#4-pools-speicherpools)
5. [Docker](#5-docker)
6. [Docker Compose](#6-docker-compose)
7. [LXC Container](#7-lxc-container)
8. [Virtual Machines (VM)](#8-virtual-machines-vm)
9. [Shares (Netzwerkfreigaben)](#9-shares-netzwerkfreigaben)
10. [Remotes (Externe Freigaben)](#10-remotes-externe-freigaben)
11. [iSCSI](#11-iscsi)
12. [Cron Jobs](#12-cron-jobs)
13. [Notifications](#13-notifications)
14. [MOS Einstellungen](#14-mos-einstellungen)
15. [Hub & Plugins](#15-hub--plugins)
16. [Terminal](#16-terminal)
17. [WebSocket-Schnittstellen](#17-websocket-schnittstellen)

---

## 1. Authentifizierung

**Basis-Pfad:** `/api/v1/auth`

Die API verwendet JWT (JSON Web Tokens) für die Authentifizierung. Alle geschützten Endpunkte erfordern einen `Authorization: Bearer <token>` Header.

### Benutzerrollen
- **admin**: Vollzugriff auf alle Funktionen
- **user**: Eingeschränkter Zugriff (nur eigenes Profil, Lesezugriff)
- **samba_only**: Nur SMB/CIFS-Zugriff

### Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/auth/firstsetup` | Boot-Token für Ersteinrichtung abrufen | ❌ |
| `POST` | `/auth/login` | Benutzer-Login | ❌ |
| `POST` | `/auth/logout` | Benutzer-Logout | ✅ |
| `GET` | `/auth/profile` | Eigenes Profil abrufen | ✅ |
| `GET` | `/auth/users` | Alle Benutzer auflisten (Admin: alle, User: nur eigenes) | ✅ |
| `POST` | `/auth/users` | Neuen Benutzer erstellen | ✅ Admin |
| `PUT` | `/auth/users/:id` | Benutzer aktualisieren | ✅ |
| `DELETE` | `/auth/users/:id` | Benutzer löschen | ✅ Admin |
| `GET` | `/auth/jwt-settings` | JWT-Einstellungen abrufen | ✅ Admin |
| `PUT` | `/auth/jwt-settings` | JWT-Ablaufzeit ändern | ✅ Admin |
| `GET` | `/auth/admin-tokens` | Admin-API-Tokens auflisten | ✅ Admin |
| `POST` | `/auth/admin-tokens` | Neuen Admin-Token erstellen | ✅ Admin |
| `DELETE` | `/auth/admin-tokens/:id` | Admin-Token löschen | ✅ Admin |
| `PUT` | `/auth/admin-tokens/:id/deactivate` | Admin-Token deaktivieren | ✅ Admin |

### Login-Beispiel
```json
POST /api/v1/auth/login
{
  "username": "admin",
  "password": "password123"
}

Response:
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "1",
    "username": "admin",
    "role": "admin"
  }
}
```

---

## 2. System

**Basis-Pfad:** `/api/v1/system`

Systeminformationen und -verwaltung.

### Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/system/memory` | Detaillierte Speicherinformationen | ✅ |
| `GET` | `/system/detailed` | Umfassende Systeminformationen | ✅ Admin |
| `GET` | `/system/load` | CPU-Last, Temperatur, Speicher, Netzwerk | ✅ |
| `GET` | `/system/network` | Netzwerkschnittstellen-Informationen | ✅ |
| `GET` | `/system/services` | Systemdienste-Status | ✅ Admin |
| `POST` | `/system/reboot` | System neustarten | ✅ Admin |
| `POST` | `/system/shutdown` | System herunterfahren | ✅ Admin |
| `POST` | `/system/update` | System-Update durchführen | ✅ Admin |

### Speicherinformationen-Struktur
```json
{
  "memory": {
    "installed": 137438953472,
    "installed_human": "128.0 GiB",
    "total": 134855393280,
    "free": 101748690944,
    "used": 33106702336,
    "breakdown": {
      "system": { "bytes": 4294967296, "percentage": 3 },
      "docker": { "bytes": 15000000000, "percentage": 11 },
      "lxc": { "bytes": 14000000000, "percentage": 10 },
      "vms": { "bytes": 0, "percentage": 0 },
      "zram": { "bytes": 536870912, "percentage": 1 }
    }
  }
}
```

---

## 3. Disks (Festplatten)

**Basis-Pfad:** `/api/v1/disks`

Festplatten- und Speicherverwaltung.

### Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/disks` | Alle Festplatten mit Partitionen auflisten | ✅ |
| `GET` | `/disks/:device/usage` | Festplattennutzung abrufen | ✅ |
| `GET` | `/disks/:device/power` | Power-Status abrufen | ✅ |
| `GET` | `/disks/:device/iostats` | I/O-Statistiken abrufen | ✅ |
| `GET` | `/disks/:device/smart` | SMART-Informationen abrufen | ✅ |
| `GET` | `/disks/availablefilesystems` | Verfügbare Dateisysteme | ✅ |
| `POST` | `/disks/:device/wake` | Festplatte aufwecken | ✅ Admin |
| `POST` | `/disks/:device/sleep` | Festplatte in Standby versetzen | ✅ Admin |
| `POST` | `/disks/format` | Festplatte formatieren | ✅ Admin |
| `POST` | `/disks/:device/preclear/abort` | PreClear-Operation abbrechen | ✅ Admin |
| `POST` | `/disks/sleep-multiple` | Mehrere Festplatten in Standby | ✅ Admin |
| `POST` | `/disks/wake-multiple` | Mehrere Festplatten aufwecken | ✅ Admin |

### Query-Parameter für `/disks`
- `performance=true/false` - Performance-Metriken einschließen
- `skipStandby=true/false` - Standby-Festplatten überspringen

### Festplatten-Typen
- `hdd` - Herkömmliche Festplatte
- `ssd` - Solid State Drive
- `nvme` - NVMe SSD
- `emmc` - eMMC-Speicher
- `usb` - USB-Gerät
- `unknown` - Unbekannt

### Power-Status
- `active` - Aktiv
- `standby` - Standby-Modus
- `sleeping` - Schlafmodus
- `unknown` - Unbekannt

---

## 4. Pools (Speicherpools)

**Basis-Pfad:** `/api/v1/pools`

Speicherpool-Verwaltung für verschiedene RAID- und Dateisystem-Konfigurationen.

### Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/pools` | Alle Pools auflisten | ✅ |
| `GET` | `/pools/availablepooltypes` | Verfügbare Pool-Typen | ✅ |
| `GET` | `/pools/:id` | Pool nach ID abrufen | ✅ |
| `GET` | `/pools/:id/status` | Pool-Status abrufen | ✅ |
| `POST` | `/pools` | Neuen Pool erstellen | ✅ Admin |
| `PUT` | `/pools/:id` | Pool aktualisieren | ✅ Admin |
| `DELETE` | `/pools/:id` | Pool löschen | ✅ Admin |
| `POST` | `/pools/:id/mount` | Pool einbinden | ✅ Admin |
| `POST` | `/pools/:id/unmount` | Pool aushängen | ✅ Admin |
| `POST` | `/pools/:id/automount` | Automount umschalten | ✅ Admin |
| `POST` | `/pools/:id/parity/start` | Parity-Operation starten | ✅ Admin |
| `POST` | `/pools/:id/parity/stop` | Parity-Operation stoppen | ✅ Admin |
| `POST` | `/pools/:id/balance` | Pool ausbalancieren (btrfs) | ✅ Admin |
| `POST` | `/pools/:id/scrub` | Pool-Scrub starten | ✅ Admin |

### Pool-Typen
- `single` - Einzelne Festplatte
- `multi` - Mehrere Festplatten (btrfs/zfs)
- `mergerfs` - MergerFS-Pool
- `nonraid` - NonRAID mit SnapRAID-Parity

### Query-Parameter für `/pools`
- `type=<type>` - Nach Typ filtern
- `exclude_type=<type>` - Typ ausschließen
- `includeMetrics=true` - Performance/Temperatur einschließen

---

## 5. Docker

**Basis-Pfad:** `/api/v1/docker`

Docker-Container-Verwaltung (nur Admin).

### Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/docker/mos/containers` | Container mit Update-Status | ✅ Admin |
| `POST` | `/docker/mos/containers` | Container-Indizes aktualisieren | ✅ Admin |
| `POST` | `/docker/mos/create` | Container aus Template erstellen | ✅ Admin |
| `DELETE` | `/docker/mos/remove` | Container und Template entfernen | ✅ Admin |
| `POST` | `/docker/mos/update_check` | Auf Updates prüfen | ✅ Admin |
| `POST` | `/docker/mos/upgrade` | Container aktualisieren | ✅ Admin |
| `POST` | `/docker/mos/start` | Container starten | ✅ Admin |
| `POST` | `/docker/mos/stop` | Container stoppen | ✅ Admin |
| `POST` | `/docker/mos/restart` | Container neustarten | ✅ Admin |
| `GET` | `/docker/mos/templates/:name` | Container-Template abrufen | ✅ Admin |
| `PUT` | `/docker/mos/templates/:name` | Container-Template aktualisieren | ✅ Admin |
| `POST` | `/docker/mos/xml-convert` | Unraid-XML zu MOS-Template konvertieren | ✅ Admin |

---

## 6. Docker Compose

**Basis-Pfad:** `/api/v1/docker/mos/compose`

Docker Compose Stack-Verwaltung (nur Admin).

### Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/docker/mos/compose/stacks` | Alle Stacks auflisten | ✅ Admin |
| `GET` | `/docker/mos/compose/stacks/:name` | Stack-Details abrufen | ✅ Admin |
| `POST` | `/docker/mos/compose/stacks` | Neuen Stack erstellen | ✅ Admin |
| `PUT` | `/docker/mos/compose/stacks/:name` | Stack aktualisieren | ✅ Admin |
| `DELETE` | `/docker/mos/compose/stacks/:name` | Stack löschen | ✅ Admin |
| `POST` | `/docker/mos/compose/stacks/:name/start` | Stack starten | ✅ Admin |
| `POST` | `/docker/mos/compose/stacks/:name/stop` | Stack stoppen | ✅ Admin |
| `POST` | `/docker/mos/compose/stacks/:name/restart` | Stack neustarten | ✅ Admin |
| `POST` | `/docker/mos/compose/stacks/:name/pull` | Images aktualisieren | ✅ Admin |

---

## 7. LXC Container

**Basis-Pfad:** `/api/v1/lxc`

LXC Linux-Container-Verwaltung (nur Admin).

### Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/lxc/containers` | Alle Container auflisten | ✅ Admin |
| `GET` | `/lxc/containers/:name` | Container-Details | ✅ Admin |
| `POST` | `/lxc/containers` | Container erstellen | ✅ Admin |
| `DELETE` | `/lxc/containers/:name` | Container löschen | ✅ Admin |
| `POST` | `/lxc/containers/:name/start` | Container starten | ✅ Admin |
| `POST` | `/lxc/containers/:name/stop` | Container stoppen | ✅ Admin |
| `POST` | `/lxc/containers/:name/restart` | Container neustarten | ✅ Admin |
| `POST` | `/lxc/containers/:name/kill` | Container beenden (force) | ✅ Admin |
| `POST` | `/lxc/containers/:name/freeze` | Container einfrieren | ✅ Admin |
| `POST` | `/lxc/containers/:name/unfreeze` | Container fortsetzen | ✅ Admin |
| `GET` | `/lxc/images` | Verfügbare Images auflisten | ✅ Admin |
| `PUT` | `/lxc/containers/:name/autostart` | Autostart umschalten | ✅ Admin |
| `PUT` | `/lxc/containers/:name/description` | Beschreibung aktualisieren | ✅ Admin |

### Container-Status
- `running` - Läuft
- `stopped` - Gestoppt
- `frozen` - Eingefroren

---

## 8. Virtual Machines (VM)

**Basis-Pfad:** `/api/v1/vm`

Virtuelle Maschinen-Verwaltung mit libvirt/KVM (nur Admin).

### Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/vm/machines` | Alle VMs auflisten | ✅ Admin |
| `GET` | `/vm/machines/:name` | VM-Details | ✅ Admin |
| `POST` | `/vm/machines/:name/start` | VM starten | ✅ Admin |
| `POST` | `/vm/machines/:name/stop` | VM stoppen (graceful) | ✅ Admin |
| `POST` | `/vm/machines/:name/kill` | VM beenden (force) | ✅ Admin |
| `POST` | `/vm/machines/:name/restart` | VM neustarten (graceful) | ✅ Admin |
| `POST` | `/vm/machines/:name/reset` | VM zurücksetzen (hard) | ✅ Admin |
| `POST` | `/vm/machines/:name/suspend` | VM pausieren | ✅ Admin |
| `POST` | `/vm/machines/:name/resume` | VM fortsetzen | ✅ Admin |
| `PUT` | `/vm/machines/:name/autostart` | Autostart umschalten | ✅ Admin |

### VM-Status
- `running` - Läuft
- `stopped` - Gestoppt

---

## 9. Shares (Netzwerkfreigaben)

**Basis-Pfad:** `/api/v1/shares`

SMB/CIFS und NFS Netzwerkfreigaben-Verwaltung (nur Admin).

### SMB-Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/shares/smb` | Alle SMB-Freigaben | ✅ Admin |
| `GET` | `/shares/smb/:id` | SMB-Freigabe nach ID | ✅ Admin |
| `POST` | `/shares/smb` | SMB-Freigabe erstellen | ✅ Admin |
| `PUT` | `/shares/smb/:id` | SMB-Freigabe aktualisieren | ✅ Admin |
| `DELETE` | `/shares/smb/:id` | SMB-Freigabe löschen | ✅ Admin |

### NFS-Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/shares/nfs` | Alle NFS-Freigaben | ✅ Admin |
| `GET` | `/shares/nfs/:id` | NFS-Freigabe nach ID | ✅ Admin |
| `POST` | `/shares/nfs` | NFS-Freigabe erstellen | ✅ Admin |
| `PUT` | `/shares/nfs/:id` | NFS-Freigabe aktualisieren | ✅ Admin |
| `DELETE` | `/shares/nfs/:id` | NFS-Freigabe löschen | ✅ Admin |

### SMB-Freigabe erstellen
```json
POST /api/v1/shares/smb
{
  "shareName": "media",
  "poolName": "storage-pool",
  "subPath": "movies",
  "enabled": true,
  "read_only": false,
  "guest_ok": false,
  "browseable": true,
  "write_list": ["user1", "user2"],
  "valid_users": ["user1", "user2", "user3"]
}
```

---

## 10. Remotes (Externe Freigaben)

**Basis-Pfad:** `/api/v1/remotes`

Verwaltung von remote eingebundenen SMB/NFS-Freigaben (nur Admin).

### Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/remotes` | Alle Remote-Mounts | ✅ Admin |
| `GET` | `/remotes/:id` | Remote nach ID | ✅ Admin |
| `POST` | `/remotes` | Remote-Mount erstellen | ✅ Admin |
| `PUT` | `/remotes/:id` | Remote-Mount aktualisieren | ✅ Admin |
| `DELETE` | `/remotes/:id` | Remote-Mount löschen | ✅ Admin |
| `POST` | `/remotes/:id/mount` | Remote einbinden | ✅ Admin |
| `POST` | `/remotes/:id/unmount` | Remote aushängen | ✅ Admin |
| `POST` | `/remotes/test` | Verbindung testen | ✅ Admin |

### Remote-Typen
- `smb` - SMB/CIFS-Freigabe
- `nfs` - NFS-Freigabe

---

## 11. iSCSI

**Basis-Pfad:** `/api/v1/iscsi`

iSCSI Target und Initiator Verwaltung (nur Admin).

### Target-Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/iscsi/targets` | Alle Targets auflisten | ✅ Admin |
| `GET` | `/iscsi/targets/info` | Target-Statistiken | ✅ Admin |
| `GET` | `/iscsi/targets/:id` | Target nach ID | ✅ Admin |
| `POST` | `/iscsi/targets` | Target erstellen | ✅ Admin |
| `PUT` | `/iscsi/targets/:id` | Target aktualisieren | ✅ Admin |
| `DELETE` | `/iscsi/targets/:id` | Target löschen | ✅ Admin |
| `POST` | `/iscsi/targets/:id/start` | Target aktivieren | ✅ Admin |
| `POST` | `/iscsi/targets/:id/stop` | Target deaktivieren | ✅ Admin |

### Initiator-Endpunkte (`/api/v1/iscsi/initiator`)

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/iscsi/initiator/sessions` | Aktive Sessions | ✅ Admin |
| `GET` | `/iscsi/initiator/discover` | Targets entdecken | ✅ Admin |
| `POST` | `/iscsi/initiator/connect` | Mit Target verbinden | ✅ Admin |
| `POST` | `/iscsi/initiator/disconnect` | Verbindung trennen | ✅ Admin |

---

## 12. Cron Jobs

**Basis-Pfad:** `/api/v1/cron`

Geplante Aufgaben-Verwaltung.

### Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/cron` | Alle Cron-Jobs auflisten | ✅ |
| `GET` | `/cron/:id` | Cron-Job nach ID | ✅ |
| `POST` | `/cron` | Cron-Job erstellen | ✅ Admin |
| `PUT` | `/cron/:id` | Cron-Job aktualisieren | ✅ Admin |
| `DELETE` | `/cron/:id` | Cron-Job löschen | ✅ Admin |
| `POST` | `/cron/:id/run` | Cron-Job manuell ausführen | ✅ Admin |
| `GET` | `/cron/scripts` | Verfügbare Scripts | ✅ Admin |
| `GET` | `/cron/scripts/:name` | Script-Inhalt abrufen | ✅ Admin |

### Cron-Job erstellen
```json
POST /api/v1/cron
{
  "name": "backup-database",
  "schedule": "0 2 * * *",
  "command": "/usr/local/bin/backup-db.sh",
  "enabled": true
}
```

---

## 13. Notifications

**Basis-Pfad:** `/api/v1/notifications`

System-Benachrichtigungen (nur Admin).

### Endpunkte

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/notifications` | Alle Benachrichtigungen | ✅ Admin |
| `GET` | `/notifications/stats` | Statistiken | ✅ Admin |
| `DELETE` | `/notifications/:id` | Benachrichtigung löschen | ✅ Admin |
| `DELETE` | `/notifications` | Alle löschen | ✅ Admin |
| `POST` | `/notifications/:id/read` | Als gelesen markieren | ✅ Admin |
| `POST` | `/notifications/read-all` | Alle als gelesen | ✅ Admin |

### Query-Parameter für GET `/notifications`
- `read=true/false` - Nach Lesestatus filtern
- `limit=<n>` - Anzahl begrenzen
- `order=asc/desc` - Sortierung

---

## 14. MOS Einstellungen

**Basis-Pfad:** `/api/v1/mos`

MOS-Systemkonfiguration (nur Admin).

### Haupteinstellungen

| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| `GET/POST` | `/mos/settings/docker` | Docker-Einstellungen |
| `GET/POST` | `/mos/settings/lxc` | LXC-Einstellungen |
| `GET/POST` | `/mos/settings/vm` | VM-Einstellungen |
| `GET/POST` | `/mos/settings/network` | Netzwerk-Einstellungen |
| `GET/POST` | `/mos/settings/system` | System-Einstellungen |
| `GET/POST` | `/mos/settings/sensors` | Sensor-Konfiguration |

### System-Einstellungen
```json
{
  "hostname": "mos-server",
  "global_spindown": true,
  "timezone": "Europe/Berlin",
  "display": {
    "timeout": 30,
    "powersave": "on"
  },
  "swapfile": {
    "enabled": false,
    "path": "/mnt/pool1",
    "size": "10G"
  }
}
```

### Docker-Einstellungen
```json
{
  "enabled": true,
  "directory": "/mnt/pool1/docker",
  "appdata": "/mnt/pool1/appdata",
  "docker_net": {
    "mode": "ipvlan",
    "config": [{"subnet": "10.0.0.0/24", "gateway": "10.0.0.1"}]
  },
  "update_check": {
    "enabled": true,
    "update_check_schedule": "0 1 * * *"
  }
}
```

### Weitere MOS-Endpunkte

| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| `GET` | `/mos/keymaps` | Verfügbare Tastaturbelegungen |
| `GET` | `/mos/timezones` | Verfügbare Zeitzonen |
| `GET` | `/mos/sensors` | Sensor-Werte auslesen |
| `GET` | `/mos/sensors/available` | Verfügbare Sensoren |
| `POST` | `/mos/settings/zram` | ZRAM-Einstellungen |
| `POST` | `/mos/settings/swap` | Swap-Einstellungen |

---

## 15. Hub & Plugins

### Hub (`/api/v1/mos/hub`)

Template-Repository-Verwaltung.

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/mos/hub/settings` | Hub-Einstellungen | ✅ Admin |
| `POST` | `/mos/hub/settings` | Hub-Einstellungen aktualisieren | ✅ Admin |
| `GET` | `/mos/hub/repositories` | Repository-URLs | ✅ Admin |
| `POST` | `/mos/hub/repositories` | Repository-URLs setzen | ✅ Admin |
| `POST` | `/mos/hub/update` | Repositories aktualisieren | ✅ Admin |
| `GET` | `/mos/hub/index` | Template-Index abrufen | ✅ Admin |
| `GET` | `/mos/hub/templates/:path` | Template abrufen | ✅ Admin |
| `GET` | `/mos/hub/categories` | Verfügbare Kategorien | ✅ Admin |

### Plugins (`/api/v1/mos/plugins`)

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/mos/plugins` | Installierte Plugins | ✅ Admin |
| `POST` | `/mos/plugins/query` | Plugin-Befehl ausführen | ✅ Admin |
| `POST` | `/mos/plugins/releases` | GitHub-Releases abrufen | ✅ Admin |
| `POST` | `/mos/plugins/install` | Plugin installieren | ✅ Admin |
| `POST` | `/mos/plugins/uninstall` | Plugin deinstallieren | ✅ Admin |

---

## 16. Terminal

**Basis-Pfad:** `/api/v1/terminal`

Web-Terminal-Zugriff.

| Methode | Endpunkt | Beschreibung | Auth |
|---------|----------|--------------|------|
| `GET` | `/terminal/sessions` | Aktive Terminal-Sessions | ✅ Admin |
| `POST` | `/terminal/sessions` | Neue Session erstellen | ✅ Admin |
| `DELETE` | `/terminal/sessions/:id` | Session beenden | ✅ Admin |

---

## 17. WebSocket-Schnittstellen

Die API bietet Echtzeit-WebSocket-Verbindungen für verschiedene Bereiche.

**Socket.io Pfad:** `/api/v1/socket.io/`

### Namespaces

| Namespace | Beschreibung |
|-----------|--------------|
| `/pools` | Pool-Status und Performance |
| `/system` | System-Load und Metriken |
| `/terminal` | Terminal-Sessions |
| `/docker` | Docker-Container-Events |
| `/disks` | Disk I/O und Temperatur |

### Verbindungsbeispiel
```javascript
const socket = io('http://server:3000/system', {
  path: '/api/v1/socket.io/',
  auth: { token: 'your-jwt-token' }
});

socket.on('system-load', (data) => {
  console.log('CPU Load:', data.cpu.load);
  console.log('Memory:', data.memory);
});

socket.emit('subscribe', { interval: 2000 });
```

### Events pro Namespace

**`/system`:**
- `system-load` - CPU, Speicher, Netzwerk-Metriken
- `subscribe/unsubscribe` - Abonnement verwalten

**`/pools`:**
- `pool-status` - Pool-Status-Updates
- `pool-performance` - Performance-Metriken

**`/docker`:**
- `container-stats` - Container-Statistiken
- `container-logs` - Container-Logs (Stream)

**`/disks`:**
- `disk-io` - I/O-Statistiken
- `disk-temperature` - Temperatur-Updates

**`/terminal`:**
- `terminal-output` - Terminal-Ausgabe
- `terminal-input` - Terminal-Eingabe

---

## Fehlerbehandlung

Alle API-Endpunkte verwenden einheitliche Fehlerformate:

```json
{
  "error": "Fehlerbeschreibung"
}
```

oder

```json
{
  "success": false,
  "error": "Fehlerbeschreibung"
}
```

### HTTP-Statuscodes

| Code | Bedeutung |
|------|-----------|
| `200` | Erfolg |
| `201` | Erstellt |
| `204` | Kein Inhalt (Löschen erfolgreich) |
| `400` | Ungültige Anfrage |
| `401` | Nicht authentifiziert |
| `403` | Keine Berechtigung |
| `404` | Nicht gefunden |
| `500` | Server-Fehler |

---

## Rate Limiting

Die API implementiert Rate-Limiting:
- **Fenster:** 1 Sekunde (konfigurierbar)
- **Max. Anfragen:** 20 pro Fenster (konfigurierbar)

Umgebungsvariablen:
- `RATE_LIMIT_WINDOW` - Fenster in Sekunden
- `RATE_LIMIT_MAX` - Max. Anfragen pro Fenster

---

## Umgebungsvariablen

| Variable | Beschreibung | Standard |
|----------|--------------|----------|
| `PORT` | API-Port | `3000` |
| `RATE_LIMIT_WINDOW` | Rate-Limit-Fenster (Sek.) | `1` |
| `RATE_LIMIT_MAX` | Max. Anfragen pro Fenster | `20` |

---

## Swagger/OpenAPI

Die vollständige OpenAPI 3.0 Spezifikation ist verfügbar unter:
- **Swagger UI:** `http://<server>:3000/api-docs`
- **JSON Spec:** `http://<server>:3000/swagger.json`
