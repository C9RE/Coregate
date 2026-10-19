using System;
using System.Collections.Generic;
using System.IO;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using HarmonyLib;
using Unity.Collections;
using Unity.Netcode;
using UnityEngine;

namespace Coregate.Gate;

[BepInPlugin("com.coregate.gate", "Coregate Gate", "1.0.0")]
[BepInDependency("com.humangenome.waygate.host")]
public class GatePlugin : BasePlugin
{
    internal static ManualLogSource LogSource;
    internal static ConfigEntry<bool> FreshOnly;
    internal static ConfigEntry<int> MaxFirstJoinLevel;
    internal static ConfigEntry<string> RejectMessage;
    internal static ConfigEntry<bool> EnablePersonalRest;
    internal static ConfigEntry<int> RestCooldownSeconds;
    internal static ConfigEntry<int> AutoSaveIntervalMinutes;
    internal static ConfigEntry<string> ServerNote;

    internal static string LedgerPath;
    internal static string SaveTriggerPath;
    internal static string SaveDonePath;
    internal static readonly HashSet<string> KnownCharacters = new(StringComparer.OrdinalIgnoreCase);
    private static readonly object LedgerLock = new();
    private static readonly Dictionary<string, long> LastRestTimestamps = new(StringComparer.OrdinalIgnoreCase);
    private static float nextAutoSaveTime = 0f;
    private static float nextTriggerCheckTime = 0f;
    private static float nextLobbySyncTime = 0f;

    public override void Load()
    {
        LogSource = Log;

        FreshOnly = Config.Bind("Gate", "FreshCharactersOnly", false,
            "Only allow fresh characters that have never joined before if they are at or below MaxFirstJoinLevel. When false, players can join with existing characters.");
        MaxFirstJoinLevel = Config.Bind("Gate", "MaxFirstJoinLevel", 1,
            "Highest level a character may have on its first join.");
        RejectMessage = Config.Bind("Gate", "RejectMessage",
            "This dedicated server requires a fresh character (Level 1). Please create a new character to join.",
            "Disconnect message displayed to players joining with pre-leveled characters.");

        EnablePersonalRest = Config.Bind("Gameplay", "EnablePersonalRest", true,
            "Allows individual players to rest in beds/tents without freezing when others are awake.");
        RestCooldownSeconds = Config.Bind("Gameplay", "RestCooldownSeconds", 600,
            "Cooldown in seconds between personal bed rests.");
        AutoSaveIntervalMinutes = Config.Bind("Gameplay", "AutoSaveIntervalMinutes", 15,
            "Interval in minutes for automatic background world saves. Set to 0 to disable.");

        ServerNote = Config.Bind("Server", "ServerNote", "Dedicated Server powered by Coregate",
            "Lobby description note displayed in the server browser.");

        LedgerPath = Path.Combine(Paths.ConfigPath, "coregate.known-characters.txt");
        SaveTriggerPath = Path.Combine(Paths.ConfigPath, "save.trigger");
        SaveDonePath = Path.Combine(Paths.ConfigPath, "save.done");

        // Clean up any stale trigger/done files from previous unclean shutdowns
        try
        {
            if (File.Exists(SaveTriggerPath)) File.Delete(SaveTriggerPath);
            if (File.Exists(SaveDonePath)) File.Delete(SaveDonePath);
        }
        catch { }

        LoadLedger();

        var harmony = new Harmony("com.coregate.gate");
        harmony.PatchAll(typeof(FreshCharacterGatePatch));

        if (EnablePersonalRest.Value)
        {
            harmony.PatchAll(typeof(PersonalRestPatch));
        }

        AddComponent<CoregateServiceComponent>();

        LogSource.LogInfo($"[Coregate] Loaded v1.0.0. FreshOnly={FreshOnly.Value}, MaxLevel={MaxFirstJoinLevel.Value}, RestFix={EnablePersonalRest.Value}, KnownCharacters={KnownCharacters.Count}");
    }

    private static void LoadLedger()
    {
        lock (LedgerLock)
        {
            try
            {
                if (File.Exists(LedgerPath))
                {
                    foreach (var line in File.ReadAllLines(LedgerPath))
                    {
                        string trimmed = line.Trim();
                        if (trimmed.Length > 0 && !trimmed.StartsWith("#"))
                        {
                            KnownCharacters.Add(trimmed);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                LogSource.LogWarning($"[Coregate] Failed to read known-characters ledger: {ex.Message}");
            }
        }
    }

    internal static void RememberCharacter(string hash)
    {
        if (string.IsNullOrWhiteSpace(hash)) return;

        lock (LedgerLock)
        {
            if (KnownCharacters.Add(hash))
            {
                try
                {
                    string dir = Path.GetDirectoryName(LedgerPath);
                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                    {
                        Directory.CreateDirectory(dir);
                    }
                    File.AppendAllText(LedgerPath, hash + Environment.NewLine);
                }
                catch (Exception ex)
                {
                    LogSource.LogWarning($"[Coregate] Failed to append character to ledger: {ex.Message}");
                }
            }
        }
    }

    internal static bool IsKnownCharacter(string hash)
    {
        if (string.IsNullOrEmpty(hash)) return false;
        lock (LedgerLock)
        {
            return KnownCharacters.Contains(hash);
        }
    }

    internal static void DisconnectClient(ulong clientId, string reason)
    {
        try
        {
            var accessType = Type.GetType("Waygate.Host.Access, WaygateHost");
            if (accessType != null)
            {
                var disconnectMethod = accessType.GetMethod("DisconnectSoon", new[] { typeof(ulong), typeof(string) });
                if (disconnectMethod != null)
                {
                    disconnectMethod.Invoke(null, new object[] { clientId, reason });
                    return;
                }
            }
        }
        catch { }

        try
        {
            NetworkManager.Singleton?.DisconnectClient(clientId, reason);
        }
        catch { }
    }

    internal static Player FindOnlinePlayerByClientId(ulong clientId)
    {
        try
        {
            var players = Utility.ReturnAllPlayers();
            if (players == null) return null;
            for (int i = 0; i < players.Count; i++)
            {
                var p = players[i];
                if ((UnityEngine.Object)(object)p == null) continue;
                var nb = (NetworkBehaviour)p;
                if (nb.NetworkObject != null && nb.NetworkObject.OwnerClientId == clientId)
                {
                    return p;
                }
            }
        }
        catch { }
        return null;
    }

    internal static void SendDirectMessage(ulong clientId, string text, Color color)
    {
        try
        {
            ChatSystem chat = null;
            var players = Utility.ReturnAllPlayers();
            if (players != null)
            {
                for (int i = 0; i < players.Count; i++)
                {
                    var p = players[i];
                    if ((UnityEngine.Object)(object)p == null) continue;
                    var c = ((Component)(object)p).GetComponent<ChatSystem>();
                    if ((UnityEngine.Object)(object)c != null)
                    {
                        chat = c;
                        break;
                    }
                }
            }
            if ((UnityEngine.Object)(object)chat == null) chat = ChatSystem.Singleton;
            if ((UnityEngine.Object)(object)chat == null) return;

            var msg = new Message
            {
                Text = text,
                Username = "Server",
                Color = color,
                Bold = true,
                MsgType = ChatMessageType.Server,
                Locale = ChatLocale.Direct,
                Source = NetworkManager.ServerClientId,
                Destination = clientId,
                LocalizationKey = "",
                LocalizationArgs = new Il2CppInterop.Runtime.InteropTypes.Arrays.Il2CppStringArray(0L)
            };
            chat.AcceptServerChatMessageClientRpc(msg, false);
        }
        catch { }
    }

    private static bool pendingSaveConfirmation = false;

    internal static bool TriggerWorldSave()
    {
        try
        {
            var spd = ServerPersistentData.Singleton;
            if (spd != null)
            {
                spd.SaveWorldDataThisFrame();
                LogSource.LogInfo("[Coregate] World state saved successfully via ServerPersistentData.");
                return true;
            }
            var found = UnityEngine.Object.FindObjectOfType<ServerPersistentData>();
            if (found != null)
            {
                found.SaveWorldDataThisFrame();
                LogSource.LogInfo("[Coregate] World state saved successfully via FindObjectOfType.");
                return true;
            }
            LogSource.LogWarning("[Coregate] Could not save world: ServerPersistentData instance not found.");
            return false;
        }
        catch (Exception ex)
        {
            LogSource.LogError($"[Coregate] World save failed: {ex.Message}");
            return false;
        }
    }

    internal static void CheckTriggersAndTimers()
    {
        // Flush pending save confirmation to disk on the frame following the save call
        if (pendingSaveConfirmation)
        {
            pendingSaveConfirmation = false;
            try
            {
                File.WriteAllText(SaveDonePath, DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString());
                LogSource.LogInfo("[Coregate] World save verified; save.done confirmation written.");
            }
            catch (Exception ex)
            {
                LogSource.LogWarning($"[Coregate] Error writing save confirmation: {ex.Message}");
            }
        }

        float now = Time.time;
        if (now < 5.0f || ServerPersistentData.Singleton == null)
        {
            return;
        }

        // 1. External Save Trigger File Check
        if (now >= nextTriggerCheckTime)
        {
            nextTriggerCheckTime = now + 1.0f;
            try
            {
                if (File.Exists(SaveTriggerPath))
                {
                    File.Delete(SaveTriggerPath);
                    LogSource.LogInfo("[Coregate] External save trigger detected.");
                    if (TriggerWorldSave())
                    {
                        pendingSaveConfirmation = true;
                    }
                }
            }
            catch (Exception ex)
            {
                LogSource.LogWarning($"[Coregate] Error checking save trigger: {ex.Message}");
            }
        }

        // 2. Periodic World Auto-Save
        if (AutoSaveIntervalMinutes.Value > 0)
        {
            if (nextAutoSaveTime <= 0f)
            {
                nextAutoSaveTime = now + (AutoSaveIntervalMinutes.Value * 60f);
            }
            else if (now >= nextAutoSaveTime)
            {
                nextAutoSaveTime = now + (AutoSaveIntervalMinutes.Value * 60f);
                LogSource.LogInfo("[Coregate] Periodic auto-save triggered.");
                TriggerWorldSave();
            }
        }

        // 3. Steam Lobby Metadata Sync
        if (now >= nextLobbySyncTime)
        {
            nextLobbySyncTime = now + 10.0f;
            try
            {
                var steam = Steam.Singleton;
                if (steam != null && !string.IsNullOrEmpty(ServerNote.Value))
                {
                    if (steam.ServerNote != ServerNote.Value)
                    {
                        steam.ServerNote = ServerNote.Value;
                    }
                    try
                    {
                        Steam.TrySetLobbyData(steam.CurrentLobby, "ServerNote", ServerNote.Value);
                        Steam.TrySetLobbyData(steam.CurrentLobby, "LobbyNote", ServerNote.Value);
                    }
                    catch { }
                }
            }
            catch { }
        }
    }

    internal static bool CheckRestCooldown(string hash, out long remainingSeconds)
    {
        remainingSeconds = 0;
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        int cooldown = RestCooldownSeconds.Value;

        if (LastRestTimestamps.TryGetValue(hash, out long lastTime) && (now - lastTime) < cooldown)
        {
            remainingSeconds = cooldown - (now - lastTime);
            return false;
        }

        LastRestTimestamps[hash] = now;
        return true;
    }
}

public class CoregateServiceComponent : MonoBehaviour
{
    public CoregateServiceComponent(IntPtr handle) : base(handle) { }

    private void Update()
    {
        GatePlugin.CheckTriggersAndTimers();
    }

    private void OnApplicationQuit()
    {
        GatePlugin.LogSource?.LogInfo("[Coregate] Application shutting down; performing final world save...");
        GatePlugin.TriggerWorldSave();
    }
}

[HarmonyPatch(typeof(SpawnManager), nameof(SpawnManager.SendPlayerDataServerRpc))]
[HarmonyPriority(Priority.First)]
internal static class FreshCharacterGatePatch
{
    private static bool Prefix(ulong clientId, NetworkPlayerData data, string version)
    {
        if (!GatePlugin.FreshOnly.Value) return true;

        try
        {
            var nm = NetworkManager.Singleton;
            if (nm == null || !nm.IsServer || clientId == NetworkManager.ServerClientId) return true;

            string hash = "";
            try
            {
                FixedString64Bytes h = data.NetworkPlayerHash;
                hash = h.ToString() ?? "";
            }
            catch { }

            string name = data.NetworkPlayerName ?? "Unknown";
            int level = Math.Max(data.NetworkPlayerLevel, data.NetworkPlayerHighestLevel);

            if (GatePlugin.IsKnownCharacter(hash))
            {
                return true;
            }

            if (!string.IsNullOrEmpty(hash) && level <= GatePlugin.MaxFirstJoinLevel.Value)
            {
                GatePlugin.RememberCharacter(hash);
                GatePlugin.LogSource.LogInfo($"[Coregate] Admitted new player '{name}' (Level {level}, Hash {hash})");
                return true;
            }

            GatePlugin.LogSource.LogWarning($"[Coregate] Rejected '{name}' (Level {level}, Hash {hash}) - character exceeds starting level cap ({GatePlugin.MaxFirstJoinLevel.Value})");
            GatePlugin.DisconnectClient(clientId, GatePlugin.RejectMessage.Value);
            return false;
        }
        catch (Exception ex)
        {
            GatePlugin.LogSource.LogError($"[Coregate] Gate check exception: {ex.Message}");
            return true;
        }
    }
}

[HarmonyPatch(typeof(SleepManager), nameof(SleepManager.RegisterSleepServerRpc))]
internal static class PersonalRestPatch
{
    private static void WakeUpPlayer(SleepManager sm, ulong playerId, Player targetPlayer)
    {
        try
        {
            if ((UnityEngine.Object)(object)targetPlayer != null)
            {
                if (targetPlayer.IsSleeping != null)
                {
                    targetPlayer.IsSleeping.Value = false;
                }

                try
                {
                    var beds = UnityEngine.Object.FindObjectsOfType<SleepClient>();
                    if (beds != null)
                    {
                        Vector3 ppos = targetPlayer.transform.position;
                        for (int i = 0; i < beds.Length; i++)
                        {
                            var bed = beds[i];
                            if ((UnityEngine.Object)(object)bed == null) continue;
                            try
                            {
                                if (bed._isOccupied != null && bed._isOccupied.Value)
                                {
                                    if (Vector3.Distance(bed.transform.position, ppos) < 6f)
                                    {
                                        bed._isOccupied.Value = false;
                                    }
                                }
                            }
                            catch { }
                        }
                    }
                }
                catch { }
            }

            if ((UnityEngine.Object)(object)sm != null)
            {
                sm.FadeFromBlackClientRpc();
                sm.ClearLocalSleepFlagsClientRpc();
                sm.HideSleepMenuClientRpc();
                try { sm.UnregisterSleepServerRpc(playerId); } catch { }
            }
        }
        catch (Exception ex)
        {
            GatePlugin.LogSource.LogWarning($"[Coregate] WakeUpPlayer error for client {playerId}: {ex.Message}");
        }
    }

    private static bool Prefix(SleepManager __instance, ulong playerId, BedType bedType, float restHours)
    {
        if (!GatePlugin.EnablePersonalRest.Value) return true;
        if (playerId == NetworkManager.ServerClientId) return true;

        Player targetPlayer = GatePlugin.FindOnlinePlayerByClientId(playerId);
        string hash = "";
        string name = "Adventurer";
        if ((UnityEngine.Object)(object)targetPlayer != null)
        {
            try { hash = targetPlayer.Hash.Value.ToString() ?? ""; } catch { }
            try { name = targetPlayer.Name.Value.ToString() ?? ""; } catch { }
        }
        if (string.IsNullOrEmpty(hash)) hash = playerId.ToString();

        if (!GatePlugin.CheckRestCooldown(hash, out long remaining))
        {
            WakeUpPlayer(__instance, playerId, targetPlayer);
            GatePlugin.SendDirectMessage(playerId, $"You are not weary yet. You can rest again in {remaining}s.", new Color(0.9f, 0.65f, 0.35f));
            return false;
        }

        try
        {
            if ((UnityEngine.Object)(object)targetPlayer != null)
            {
                var obj = (ObjectsCommon)targetPlayer;
                float maxHp = obj.MaxHealth != null ? obj.MaxHealth.Value : 100f;
                float maxStam = obj.MaxStamina != null ? obj.MaxStamina.Value : 100f;
                float maxConc = obj.MaxConcentration != null ? obj.MaxConcentration.Value : 100f;

                obj.SetHealth(maxHp);
                obj.SetStamina(maxStam);
                obj.SetConcentration(maxConc);
            }
        }
        catch (Exception ex)
        {
            GatePlugin.LogSource.LogWarning($"[Coregate] Personal rest vital restore error: {ex.Message}");
        }

        WakeUpPlayer(__instance, playerId, targetPlayer);
        GatePlugin.SendDirectMessage(playerId, "You lay down and rest peacefully. Health, stamina, and concentration restored.", new Color(0.45f, 0.85f, 0.55f));
        GatePlugin.LogSource.LogInfo($"[Coregate] Handled personal rest for client {playerId} ('{name}')");

        return false;
    }
}
