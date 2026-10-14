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

| Layer                                               | State                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Reference parsing, canonicalisation, errors         | **ported** — a modifier is a whole segment, legal only last; no warning exists                   |
| Failure codes (`ERROR_CODES`, RFC 1 §5.3)           | **ported** — both failure types carry `code()`, `selector()`, `scope()` and `candidates()`       |
| Mask pass (`masked`, `commentsIn`)                  | **ported** — the mask invariant is asserted, as the spec requires                                |
| Block scanner (`scanBlocks`)                        | **ported** — regions, comment anchors, condition literals, properties, an enum's constants, if/else chains, headers that wrap |
| Resolution (`resolveSection`, `extractDeclaration`) | **ported**                                                                                       |
| Per-language lexers (the language table)            | **ported** — all eighteen entries and the extension registry, Kotlin's `fun` shapes included     |
| Envelopes (`Inventory/^,toString,$`)                | **ported** — `^`/`$` are whole path segments; the pair is validated at parse, and the block is chosen by what the marks wrap |

`mvn test` is therefore **green** — `Tests run: 35, Failures: 0`, all 310 section vectors
and all 53 lexical shape rows asserted. Nothing is skipped and no assertion is weakened.

The `vectors:` line the suite prints reads `310 asserted, 94 with a code compared, 216
resolving and 0 failing`. The two bare-mark rows (`^` and `$`) are among the compared codes:
they carry a `resolution/envelope-alone` code because the pair is what cannot be read, while
the JavaScript raises its *grammar* error type for them because the reference is read without
a file. The Java port does the same — the envelope pair is validated by `parse` — so the type
follows the raise site and the code keeps its namespace: the harness asserts the type from the
code's namespace and only where that namespace implies one, so a `grammar/…` code requires a
`SectionReferenceException` while a `resolution/…` code (the envelope pair included) implies
no type at all (RFC 1 §3.6).

```sh
mvn test        # the gate
mvn package     # jar + sources + javadoc, as Maven Central wants them
```

`SectionVectorsTest` reads
[`test/vectors/section-vectors.json`](../../test/vectors/section-vectors.json) —
the same 310 vectors `node tools/section-vectors.mjs --check` holds the JavaScript
to — and asserts all of them: the grammar, the exact error text **and the stable
failure code** beside it, and resolution against the fixtures, each through the
language its file extension selects. A row's `parser` field names the entry point
that reads it — `parseReference`, the single-path-selector reader, for the one row
about the difference between a line range and a section path — and a row that
resolves must carry no code at all. It fails if a vector is unaccounted for, so
nothing can quietly leave the gate.

`LexicalVectorsTest` reads
[`test/vectors/lexical-vectors.json`](../../test/vectors/lexical-vectors.json),
generated from the JavaScript by `tools/lexical-vectors.mjs`: one **mask** row
per lexer entry — all eighteen, plus the built-in engine for an unknown type —
and one **shape** row per discriminating declaration spelling (`impl<T>` beside
`impl`, `publish…` beside `pub name`, a primed or indented Haskell binding, a VB
modifier). Resolution vectors can only exercise the six lexer entries their
fixtures name, so without this corpus a mistranslated matcher for any of the
other twelve would pass every gate. The Zig port keeps a *generated* copy of both
corpora because it has no JSON reader; reading them directly is deliberately
better here, since a file that cannot drift needs no drift gate.

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
