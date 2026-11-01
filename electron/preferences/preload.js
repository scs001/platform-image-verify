// ── Preload script for Preferences window ─────────────────────────────────────
// Exposes only the whitelisted IPC channels via contextBridge.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("platform", {
  // Get visible whitelisted settings
  getVisibleSettings: () => ipcRenderer.invoke("settings:get-visible"),

  // Set a settings field
  setSettingField: (key, value) => ipcRenderer.invoke("settings:set-field", { key, value }),


  // Restart a service after changes
  restartService: (id) => ipcRenderer.invoke("service:restart", { id }),

  // Resident steward (后台管家): consent text, install/uninstall, live status.
  getStewardConsent: () => ipcRenderer.invoke("steward:consent"),
  getStewardStatus: () => ipcRenderer.invoke("steward:status"),
  installSteward: () => ipcRenderer.invoke("steward:install"),
  // Repair (add-desktop-residency-hardening): re-register the autostart
  // idempotently and clear the crash history.
  repairSteward: () => ipcRenderer.invoke("steward:repair"),
  uninstallSteward: () => ipcRenderer.invoke("steward:uninstall"),
  // Uplink pairing (add-cell-lifecycle chapter 4): bind-code pair + unpair.
  pairSteward: (code, label) => ipcRenderer.invoke("steward:pair", { code, label }),
  unpairSteward: () => ipcRenderer.invoke("steward:unpair"),
});
