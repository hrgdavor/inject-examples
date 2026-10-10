# Publishing from this repository

Two different things ship from here, on two different routes:

| What | Route |
| --- | --- |
| `@hrg/inject-examples` — the CLI and `lib/section.mjs` | `npm publish` |
| `hr.hrg.inject:inject-examples` — the Java matcher, in [`java/section`](java/section) | Maven Central, via the Central Portal |
| The Zig binary | a `v*` tag builds it in `.github/workflows/release.yml` and attaches it to a GitHub release |

This document collects the **caveats** — the things that make a Maven release fail *quietly* — so the
next artifact published from here does not rediscover them. The module-specific steps are in
[`java/section/PUBLISHING.md`](java/section/PUBLISHING.md); the configuration they describe is the
reusable recipe, and it lives in [`java/section/pom.xml`](java/section/pom.xml).

## The Maven Central caveats

**1. `mvn` on the PATH is an `mvnd` shim, and it silently skips the publishing mojo.**
Observed on the machine this was written on:

```
mvn -version  ->  Apache Maven Daemon (mvnd) 1.0.0-m4, Maven 4.0.0-alpha-4, JDK 25, D:\programs\mvnd
```

A bare `mvn clean deploy` there builds the bundle, prints nothing about publishing, and uploads
nothing. Use the real Maven binary, which is a different install with a different JDK:

```
D:\programs\mvn\bin\mvn.cmd -version  ->  Apache Maven 3.9.0, JDK 21
```

**2. Because those two Mavens run different JDKs, anything JDK-dependent has to be valid on the older
one.** The Java artifact targets **21** and enforces it (`requireJavaVersion [21,)`), because 21 is the
release JDK — nothing in the matcher needs a newer one. Both builds are green today, but the trap is
real and was hit here: an option that works on JDK 25 was rejected by JDK 21 and broke a release-shaped
build that had passed all day under `mvnd`. Whatever a POM adds — a compiler flag, a javadoc option —
verify it with the real Maven binary.

**3. On Windows, GPG's default pinentry is a GUI dialog that does not render in a non-interactive
console, so signing *hangs* instead of failing.** Two halves are needed:
the POM passes `--pinentry-mode loopback`, and the agent must allow it —

```
# %APPDATA%\gnupg\gpg-agent.conf
allow-loopback-pinentry
```

then `gpgconf --kill gpg-agent`. (This machine already has that line; do not remove it.)

**4. The signing passphrase comes from `settings.xml`, never from a prompt.** The POM sets
`<passphraseServerId>gpg</passphraseServerId>`, so `~/.m2/settings.xml` needs a `gpg` server entry whose
`<passphrase>` is the key's. `gpg.skip` defaults to **true** so local builds never stall; a release
passes `-Dgpg.skip=false`.

**5. The publishing plugin creates the deployment on the *last* module in the reactor that carries the
mojo**, and it honours that module's `skipPublishing`. A module with `skipPublishing=true` therefore
wins and a bare `mvn clean deploy` uploads nothing. Harmless while `java/section` is the only Maven
module; as soon as a second one appears, the release becomes
`mvn clean deploy -pl <the published modules> -am`.

**6. The namespace has to be verified in the Central Portal** — `hr.hrg.inject` — before the first
deploy, and the GPG public key has to be on a keyserver, because the portal validates signatures
against public keyservers. (The sibling `dia-log` project verifies `hr.hrg.dialog` the same way.)

**7. Tokens and passphrases never enter the repository.** `settings.xml` stays in `~/.m2`.

## Releasing the Java matcher

```sh
D:\programs\mvn\bin\mvn.cmd clean deploy -Dgpg.skip=false
```

`autoPublish` is `true`, so the portal publishes as soon as it validates the bundle; pass
`-DautoPublish=false` to inspect it in the portal first. Details, versioning and the consumer-pinning
note are in [`java/section/PUBLISHING.md`](java/section/PUBLISHING.md).

## Adding the next artifact

1. Copy the publishing block from [`java/section/pom.xml`](java/section/pom.xml): the sources and
   javadoc plugins, the `maven-gpg-plugin` execution (with `skip`, `passphraseServerId` and the
   loopback argument), the `central-publishing-maven-plugin` with `<extensions>true</extensions>`, and
   the `distributionManagement` portal URLs.
2. Give it `<licenses>`, `<developers>` and `<scm>` — Central validates them.
3. Keep `gpg.skip` defaulting to `true`.
4. In an XML comment, never write a double dash: `--` is illegal there and the POM stops parsing — an
   easy way to break a build while documenting a flag.
4. Repeat the caveats above in that module's own `PUBLISHING.md` only if it has steps of its own;
   otherwise point here.

## Checklist before a release

- [ ] `mvn clean package` (real Maven) succeeds and builds the jar, sources and javadoc.
- [ ] `<version>` has no `-SNAPSHOT`.
- [ ] The GPG public key is on a keyserver, and `allow-loopback-pinentry` is set.
- [ ] `settings.xml` has the `central` (portal token) and `gpg` (passphrase) servers.
- [ ] The namespace for the artifact's groupId is verified in the Central Portal.
- [ ] The real Maven binary is used — not the `mvnd` shim.
- [ ] Every consumer that pins the version was bumped: for the Java matcher that is `webview-core`'s
      POM and the JetBrains plugin's Gradle build.
