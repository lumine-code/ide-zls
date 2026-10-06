const { serverApi } = require("./helpers/server-resolver");

describe("ZLS installation SDK lifetime", () => {
  for (const operation of ["latest", "install"]) {
    it(`rejects an expired ${operation} SDK probe without starting release discovery`, async () => {
      const server = require("../lib/server");
      const controller = new AbortController();
      const reason = new DOMException("Installation canceled", "AbortError");
      let entered, finish;
      const started = new Promise((resolve) => (entered = resolve));
      spyOn(server, "probeVersion").and.callFake(
        (_command, _args, options = {}) =>
          new Promise((resolve, reject) => {
            entered();
            finish = () => resolve("0.16.0");
            options.signal?.addEventListener("abort", () => reject(options.signal.reason), {
              once: true,
            });
          }),
      );
      const api = serverApi({
        signal: controller.signal,
        latestGithubRelease: jasmine
          .createSpy("latest release")
          .and.resolveTo({ version: "0.16.0" }),
        githubReleaseByTag: jasmine
          .createSpy("release by tag")
          .and.resolveTo({ version: "0.16.0", assets: [] }),
      });
      const pending =
        operation === "latest"
          ? server.latestServerVersion(api, process.execPath)
          : server.installServer(
              { storagePath: __dirname, version: "0.16.0", api, signal: controller.signal },
              process.execPath,
            );
      const outcome = pending.catch((error) => error);
      await started;
      controller.abort(reason);
      finish();
      expect(await outcome).toBe(reason);
      expect(api.latestGithubRelease).not.toHaveBeenCalled();
      expect(api.githubReleaseByTag).not.toHaveBeenCalled();
    });
  }
});
