const API_ORIGIN = "https://api.github.com";
const diagnosticHeaders = [
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
  "retry-after",
  "x-github-request-id",
];

// The integration fixture owns this credential; the shared installer and the
// public native archive downloads keep their ordinary transport contracts.
exports.createGithubFetch = ({
  token = "",
  fetchUrl = (url, init) => fetch(url, init),
  onFailure = (details) => console.error("ZLS_GITHUB_METADATA " + JSON.stringify(details)),
} = {}) => {
  const credential = token.trim();
  const safe = (value) => {
    const text = String(value ?? "");
    return (credential ? text.replaceAll(credential, "[redacted]") : text).slice(0, 256);
  };
  return async (url, init = {}) => {
    const target = new URL(url);
    const githubApi = target.origin === API_ORIGIN && !target.username && !target.password;
    const headers = new Headers(init.headers);
    // A public archive must not inherit the metadata credential, even if a
    // caller accidentally reuses the previous request's header collection.
    headers.delete("Authorization");
    if (githubApi && credential) headers.set("Authorization", `Bearer ${credential}`);
    const response = await fetchUrl(url, {
      ...init,
      headers,
      redirect: githubApi ? "manual" : (init.redirect ?? "follow"),
    });
    if (githubApi && !response.ok) {
      let message;
      try {
        message = (await response.clone().json()).message;
      } catch {
        // A non-JSON rejection still has a useful status and request identity.
      }
      onFailure({
        status: response.status,
        path: target.pathname,
        headers: Object.fromEntries(
          diagnosticHeaders
            .filter((name) => response.headers.has(name))
            .map((name) => [name, safe(response.headers.get(name))]),
        ),
        ...(message == null ? {} : { message: safe(message) }),
      });
    }
    // Metadata redirects are rejected rather than carrying the credential to
    // another origin. Asset downloads use their own unauthenticated requests.
    if (githubApi && response.status >= 300 && response.status < 400)
      throw new Error("GitHub metadata redirect was refused by the integration transport.");
    return response;
  };
};
