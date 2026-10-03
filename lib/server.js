const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const REPOSITORY = "zigtools/zls";
const TARGETS = {
  "win32-x64": "x86_64-windows",
  "win32-arm64": "aarch64-windows",
  "win32-ia32": "x86-windows",
  "darwin-x64": "x86_64-macos",
  "darwin-arm64": "aarch64-macos",
  "linux-x64": "x86_64-linux",
  "linux-arm64": "aarch64-linux",
  "linux-arm": "arm-linux",
  "linux-ia32": "x86-linux",
  "linux-riscv64": "riscv64-linux",
  "linux-ppc64": "powerpc64le-linux",
  "linux-s390x": "s390x-linux",
};

exports.findOnPath = (name, env = process.env, platform = process.platform) => {
  for (const directory of (env.PATH || env.Path || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of platform === "win32" ? ["", ".exe"] : [""]) {
      const candidate = path.join(directory, name + extension);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* Try the next native executable. */
      }
    }
  }
  return null;
};
exports.probeVersion = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          return reject(new Error(String(stderr || error.message).trim(), { cause: error }));
        const version = String(stdout).trim();
        if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version))
          return reject(new Error("The selected executable did not report a Zig or ZLS version."));
        resolve(version);
      },
    );
  });
const executable = async (command, label) => {
  if (!path.isAbsolute(command)) throw new Error(`${label} must be an absolute executable path.`);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command))
    throw new Error(`${label} must name a native executable, not a shell wrapper.`);
  if (!(await fs.promises.stat(command)).isFile())
    throw new Error(`${label} must name an executable file.`);
  await fs.promises.access(command, fs.constants.X_OK);
  return command;
};
exports.resolveZig = async (configured = "", env = process.env) => {
  const command = configured || exports.findOnPath("zig", env);
  return command ? executable(command, "Zig Path") : null;
};
exports.resolveServer = async (configured = "", managed = null, zigPath = "") => {
  const command = configured || managed?.binaryPath || exports.findOnPath("zls");
  if (!command) return null;
  await executable(command, "Server Path");
  const zig = await exports.resolveZig(zigPath);
  if (!zig) return null;
  const [version, zigVersion] = await Promise.all([
    exports.probeVersion(command, ["--version"]),
    exports.probeVersion(zig, ["version"]),
  ]);
  if (zigVersion.includes("-dev"))
    throw new Error("Select a stable Zig SDK for ZLS release builds.");
  if (version.split(".").slice(0, 2).join(".") !== zigVersion.split(".").slice(0, 2).join("."))
    throw new Error(
      `ZLS ${version} and Zig ${zigVersion} must use the same major and minor version. Select a matching server or Zig SDK.`,
    );
  return { command, args: [], version };
};
exports.assetFor = ({ platform, arch }) => {
  const target = TARGETS[`${platform}-${arch}`];
  return target ? `zls-${target}.${platform === "win32" ? "zip" : "tar.xz"}` : null;
};
exports.latestServerVersion = async (api, zigPath = "") => {
  const zig = await exports.resolveZig(zigPath);
  if (!zig) return (await api.latestGithubRelease(REPOSITORY)).version;
  const version = await exports.probeVersion(zig, ["version"]);
  if (version.includes("-dev"))
    throw new Error("Select a stable Zig SDK for managed ZLS releases.");
  const latest = await api.latestGithubRelease(REPOSITORY);
  const minor = version.split(".").slice(0, 2).join(".");
  if (String(latest.version).split(".").slice(0, 2).join(".") === minor) return latest.version;
  const release = await api.githubReleaseByTag(
    REPOSITORY,
    version.split(".").slice(0, 2).join(".") + ".0",
  );
  return release.version;
};
exports.installServer = async (
  { storagePath, version, api },
  zigPath = "",
  target = { platform: process.platform, arch: process.arch },
) => {
  const assetName = exports.assetFor(target);
  if (!assetName)
    throw new Error(`ZLS publishes no supported build for ${target.platform}-${target.arch}.`);
  const selected = version || (await exports.latestServerVersion(api, zigPath));
  if (!/^\d+\.\d+\.\d+$/.test(String(selected))) throw new Error("Choose a stable ZLS release.");
  if (zigPath) {
    const zig = await exports.resolveZig(zigPath);
    const sdk = await exports.probeVersion(zig, ["version"]);
    if (
      sdk.includes("-dev") ||
      sdk.split(".").slice(0, 2).join(".") !== String(selected).split(".").slice(0, 2).join(".")
    )
      throw new Error("Select a ZLS release matching the configured stable Zig SDK.");
  }
  const release = await api.githubReleaseByTag(REPOSITORY, String(selected));
  const asset = release.assets.find(({ name }) => name === assetName);
  if (!asset) throw new Error(`ZLS ${selected} does not publish ${assetName}.`);
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || ""))
    throw new Error(`ZLS did not publish a SHA256 digest for ${assetName}.`);
  api.setServerInstallationStatus("downloading");
  await api.downloadFile(asset.url, storagePath, {
    type: target.platform === "win32" ? "zip" : "xz-tar",
    digest: asset.digest,
  });
  const binary = target.platform === "win32" ? "zls.exe" : "zls",
    binaryPath = path.join(storagePath, binary);
  await api.makeFileExecutable(binaryPath);
  await executable(binaryPath, "Managed ZLS");
  return { version: release.version, binary, checksum: asset.digest, asset: assetName };
};
