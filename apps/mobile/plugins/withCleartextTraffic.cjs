const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

module.exports = function withCleartextTraffic(config) {
  // 1. AndroidManifest: enable usesCleartextTraffic and link networkSecurityConfig
  config = withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;
    if (manifest && manifest.application && manifest.application[0]) {
      const app = manifest.application[0];
      app.$ = app.$ || {};
      app.$["android:usesCleartextTraffic"] = "true";
      app.$["android:networkSecurityConfig"] = "@xml/network_security_config";
    }

    // Ensure android.permission.INTERNET is present
    if (manifest && !manifest["uses-permission"]) {
      manifest["uses-permission"] = [];
    }
    const hasInternet = manifest["uses-permission"].some(
      (item) => item.$ && item.$["android:name"] === "android.permission.INTERNET"
    );
    if (!hasInternet) {
      manifest["uses-permission"].push({
        $: { "android:name": "android.permission.INTERNET" },
      });
    }

    return modConfig;
  });

  // 2. DangerousMod: generate res/xml/network_security_config.xml
  config = withDangerousMod(config, [
    "android",
    async (modConfig) => {
      const resXmlDir = path.join(
        modConfig.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml"
      );
      if (!fs.existsSync(resXmlDir)) {
        fs.mkdirSync(resXmlDir, { recursive: true });
      }
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;
      const destXml = path.join(resXmlDir, "network_security_config.xml");
      fs.writeFileSync(destXml, xmlContent, "utf8");
      return modConfig;
    },
  ]);

  return config;
};
