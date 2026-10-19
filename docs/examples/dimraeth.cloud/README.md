# Example: Dimraeth.cloud

These are the settings [Dimraeth.cloud](https://dimraeth.cloud/) runs in production on COREGATE: a 24-seat realm where every character starts at level 1 and has to earn its levels on the realm.

Use them as a starting point for a fresh-start server of your own. Replace the name, note and messages with your own; please don't present your server as Dimraeth.cloud.

Only the keys that differ from the defaults are listed. Secrets (admin password, join password, Discord webhook) are left out.

| File | Section | Key | Value |
| :--- | :--- | :--- | :--- |
| `com.humangenome.waygate.host.cfg` | `[Host]` | `MaxPlayers` | `24` |
| `com.humangenome.waygate.host.cfg` | `[Host]` | `ServerName` | `Dimraeth.cloud - COREGATE` |
| `com.humangenome.waygate.host.cfg` | `[World]` | `NewCharactersOnly` | `true` |
| `com.humangenome.waygate.admin.cfg` | `[Chat]` | `Motd` | see below |

The full Coregate gate config is in [`com.coregate.gate.cfg`](com.coregate.gate.cfg).

MOTD:

```
Welcome to COREGATE [Dimraeth.cloud] - Dedicated 24-Seat Realm - Fresh Level 1 characters only - Conquer all 11 bosses together - Live realm roster & rules: https://dimraeth.cloud
```
