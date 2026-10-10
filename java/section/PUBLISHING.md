# Publishing `hr.hrg.inject:inject-examples`

The shared caveats — the `mvnd` shim that skips the publishing mojo, the Windows GPG pinentry stall, the
JDK difference between the two Mavens, the reactor rule and the namespace verification — are in
[`../../PUBLISHING.md`](../../PUBLISHING.md). Read that first; this file adds only what is specific to
this module.

## What ships

One artifact from one module: `hr.hrg.inject:inject-examples`. It is the matcher only, not the CLI, so
it versions independently of the npm package.

## Release

```sh
D:\programs\mvn\bin\mvn.cmd clean deploy -Dgpg.skip=false
```

Run it from this directory (`java/section`), or with `-pl java/section -am` from the repository root if
the build ever grows other Maven modules. `gpg.skip` defaults to `true`, so an ordinary `mvn install`
here never touches GPG; `autoPublish` is `true`, so the portal publishes once it validates the bundle —
pass `-DautoPublish=false` to review it in the portal first.

## Versioning and its consumers

Bump `<version>` here, and update `<scm><tag>` if this POM carries one, to match the release tag. Two
places pin the version, and neither follows automatically:

- `webview-core` (jcodebuddy) declares the dependency explicitly in
  `webview/core/webview-core/pom.xml`;
- the JetBrains plugin declares it again in `webview-jetbrains/build.gradle.kts`, because
  `isTransitive = false` keeps it from arriving with the core — which is also why the plugin would fail
  at runtime, not at build time, if it were forgotten.

## Checklist

- [ ] `D:\programs\mvn\bin\mvn.cmd clean package` succeeds — the JDK 21 build the release uses (the POM
      targets 21 and enforces 21+).
- [ ] `mvn test` is green: the 72 conformance vectors, the API test and the dependency-boundary test.
- [ ] `<version>` has no `-SNAPSHOT`.
- [ ] The `hr.hrg.inject` namespace is verified in the Central Portal.
- [ ] Both consumers above are bumped to the released version.
