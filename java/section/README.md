# `java/section` — the Java implementation

A Java implementation of the file-section matcher: it resolves a `#<reference>`
against the text of a file, the way [`lib/section.mjs`](../../lib/section.mjs)
does. [doc/section-matching.md](../../doc/section-matching.md) is the normative
specification, and the JavaScript is the source of truth — **a port mirrors, it
does not lead** ([plans/zig-port.md](../../plans/zig-port.md) §2), so a
disagreement here is a bug here.

It exists for the JVM hosts (an IDE plugin, a sidecar, a build tool) that cannot
import the ES module, and it is the sibling of the Rust implementation in
[`rust/section`](../../rust/section).

## Status

| Layer | State |
| --- | --- |
| Reference parsing, canonicalisation, errors, the contradiction warning | **ported** |
| Mask pass (`masked`, `commentsIn`) | **ported** — the mask invariant is asserted, as the spec requires |
| Block scanner (`scanBlocks`) | **ported** — regions, comment anchors, condition literals, properties, if/else chains |
| Resolution (`resolveSection`, `extractDeclaration`) | **ported** |
| Per-language lexers (the language table) | **ported** — all eighteen entries and the extension registry |

All 72 conformance vectors pass.

```sh
mvn test        # the gate
mvn package     # jar + sources + javadoc, as Maven Central wants them
```

`SectionVectorsTest` reads
[`test/vectors/section-vectors.json`](../../test/vectors/section-vectors.json) —
the same 72 vectors `node tools/section-vectors.mjs --check` holds the JavaScript
to — and asserts all of them: the grammar, the exact error text, the
contradiction warning, and resolution against the fixtures, each through the
language its file extension selects. It fails if a vector is unaccounted for, so
nothing can quietly leave the gate. The Zig port keeps a *generated* copy because
it has no JSON reader; reading the corpus directly is deliberately better here,
since a file that cannot drift needs no drift gate.

## Boundary

The library has **no dependencies**, by the same rule that keeps
`lib/section.mjs` vendorable: pure text in, text out, no filesystem, no
environment, no editor types, no CLI. JUnit and Jackson (3.x, `tools.jackson`)
are test-only. Every entry point takes a `String` and returns a value or throws;
the caller owns all I/O.

The language table is data plus a lexer, not a parser, per the design boundary
the plan set keeps: adding a language is one entry and one extension line, never
new matching logic.

## Coordinates

```xml
<dependency>
  <groupId>hr.hrg.inject</groupId>
  <artifactId>inject-examples</artifactId>
  <version>0.1.0</version>
</dependency>
```

Java 21 (bytecode target 21; the library uses nothing newer, and the build enforces 21+).

**Not on Maven Central yet.** To use it from another project today, install it into
your local repository and depend on the same coordinates:

```sh
mvn install     # -> ~/.m2/repository/hr/hrg/inject/inject-examples/0.1.0/
```

The POM is release-ready: the metadata Central asks for, the sources and javadoc
jars, GPG signing (off by default — `-Dgpg.skip=false` for a release) and the
Central Portal publishing plugin. The route, the proven plugin versions and the
two traps that make a release fail *quietly* are in [PUBLISHING.md](PUBLISHING.md)
— the short version: use the real Maven binary rather than an `mvnd` shim, and let
GPG allow loopback pinentry on Windows.
