// The app is a client for user-entered self-hosted instances, which may be
// plain http on a LAN (and CI's mock is http://10.0.2.2:9411). Expo/RN's
// template ships a network_security_config that forbids cleartext in release
// and OVERRIDES android:usesCleartextTraffic (Android 9+ precedence). Remove
// the attribute so the manifest flag governs (app.json sets it true).
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (application?.$?.["android:networkSecurityConfig"]) {
      delete application.$["android:networkSecurityConfig"];
    }
    return cfg;
  });
