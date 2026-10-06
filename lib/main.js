const server = require("./server");
const path = require("node:path");
const setting = (name) => lumine.config.get(`ide-zls.${name}`);
const settings = async (context) => {
  const options = {};
  const zig = await server.resolveZig(context, setting("zigPath"));
  if (zig) options.zig_exe_path = zig;
  const build = setting("buildOnSave");
  if (build === "enabled" || build === "disabled")
    options.enable_build_on_save = build === "enabled";
  const hints = setting("parameterHints");
  if (hints === "enabled" || hints === "disabled")
    options.inlay_hints_show_parameter_name = hints === "enabled";
  return options;
};
const zonAvailable = new Set(["diagnostics", "format", "semanticTokens"]);
module.exports = {
  consumeIdeClient(client) {
    return client.registerAdapter({
      id: "ide-zls",
      displayName: "ZLS",
      grammarScopes: ["source.zig"],
      languageId: "zig",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-zls"],
      restartKeyPaths: ["ide-zls.serverPath", "ide-zls.zigPath"],
      managedServerDisplayName: "ZLS",
      latestServerVersion: (api) => server.latestServerVersion(api, setting("zigPath")),
      installServer: (context) => server.installServer(context, setting("zigPath")),
      isFeatureAvailable: (feature, editor) =>
        !(
          editor?.getPath?.() &&
          path.extname(editor.getPath()).toLowerCase() === ".zon" &&
          !zonAvailable.has(feature)
        ),
      async resolveServer(context) {
        const launch = await server.resolveServer(
          context,
          setting("serverPath"),
          setting("zigPath"),
        );
        if (!launch) {
          client.reportMissingServer("ide-zls", {
            description:
              "Install a matching Zig SDK and ZLS release. Manage Servers can install ZLS; select the Zig executable in Zig Path when it is not on PATH.",
          });
          return null;
        }
        return { ...launch, cwd: context.rootPath, transport: "stdio" };
      },
      getInitializationOptions: settings,
      getSettings: settings,
      getWorkspaceConfiguration(section, _scopeUri, context) {
        return !section || section === "zls" ? settings(context) : undefined;
      },
    });
  },
  provideBackgroundTips() {
    return {
      packageName: "ide-zls",
      tips: [
        "ZLS reads build.zig to resolve your project's imports. Add a check build step to enable compiler diagnostics on save while preserving the project's normal build.",
      ],
    };
  },
};
