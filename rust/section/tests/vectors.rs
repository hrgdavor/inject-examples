//! The parity gate: the golden vectors, against this implementation.
//!
//! `test/vectors/section-vectors.json` is the conformance set the JavaScript
//! matcher is held to, and the rule for a port is that it mirrors rather than
//! leads (`plans/zig-port.md` §2). So this test reads that file directly instead
//! of keeping a generated copy: the Zig port needs `tools/zig-vectors.mjs`
//! because it has no JSON reader, while Rust has one as a test-only dependency,
//! and a file that cannot drift is better than one that can.
//!
//! Every vector is asserted: **grammar** and **grammar-error** through
//! `parse_selectors` (exact error text), and **resolution** through
//! `plan_section` — comparing the text, the
//! 1-based inclusive line ranges, their outermost bounds and the matcher `kind`
//! (`lines` for a line range, `multiple` for several selectors), or the error text
//! for the rows whose expected answer is an error. A vector that is neither
//! asserted nor counted as pending fails the accounting check at the end, so
//! nothing can quietly leave the gate.

use inject_sections::parse_selectors;
use inject_sections::resolver::{plan_section, resolve_section, Plan};
use inject_sections::syntaxes::lexer_for_path;
use serde_json::Value;

/// Every vector, as parsed JSON. The file lives with the JavaScript suite, so the
/// path is relative to the crate (`rust/section/`).
fn vectors() -> Vec<Value> {
    let path = repo_path("test/vectors/section-vectors.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
    serde_json::from_str(&text).expect("section-vectors.json is an array of vectors")
}

/// A path in the repository, from the crate directory.
fn repo_path(relative: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
}

/// A fixture's own bytes.
fn fixture(relative: &str) -> String {
    let path = repo_path(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()))
}

/// A plan's line ranges as `[(from, to)]`, 1-based and inclusive.
fn line_ranges(plan: &Plan) -> Vec<(usize, usize)> {
    plan.ranges
        .iter()
        .map(|range| (range.from, range.to))
        .collect()
}

#[test]
fn reference_grammar_matches_the_vectors() {
    let vectors = vectors();
    let mut failures: Vec<String> = Vec::new();
    let mut asserted = 0;
    // Nothing is pending any more: every layer the vectors exercise is ported. The accounting check at
    // the end keeps this list honest if a vector is ever added for a layer that does not exist yet.
    let pending: Vec<&str> = Vec::new();

    for vector in &vectors {
        let name = vector["name"].as_str().unwrap_or("<unnamed>");
        let reference = vector["reference"].as_str().unwrap_or("");
        let expected_error = vector["error"].as_str();

        // A vector without an input fixture exercises the grammar alone; one with an
        // input resolves a section through the mask, scanner and matcher layers.
        let Some(input) = vector["input"].as_str() else {
            asserted += 1;
            assert_grammar_vector(name, reference, expected_error, &mut failures);
            continue;
        };

        let path = repo_path(input);
        let source = match std::fs::read_to_string(&path) {
            Ok(source) => source,
            Err(error) => {
                failures.push(format!("{name}: reading {}: {error}", path.display()));
                continue;
            }
        };
        let lexer = lexer_for_path(input);
        asserted += 1;

        match (plan_section(&source, reference, &*lexer), expected_error) {
            (Err(error), Some(expected)) => {
                if error.to_string() != expected {
                    failures.push(format!("{name}: got error {error:?}, want {expected:?}"));
                }
            }
            (Ok(plan), None) => {
                let want_text = vector["text"].as_str().unwrap_or("");
                if plan.text != want_text {
                    failures.push(format!(
                        "{name}: text {:?}, want {:?}",
                        first_lines(&plan.text),
                        first_lines(want_text)
                    ));
                }
                let want_kind = vector["kind"].as_str().unwrap_or("");
                if plan.kind != want_kind {
                    failures.push(format!("{name}: kind {:?}, want {want_kind:?}", plan.kind));
                }
                for (field, want, got) in [
                    (
                        "startLine",
                        vector["startLine"].as_u64(),
                        plan.start_line as u64,
                    ),
                    ("endLine", vector["endLine"].as_u64(), plan.end_line as u64),
                ] {
                    if want != Some(got) {
                        failures.push(format!("{name}: {field} {got}, want {want:?}"));
                    }
                }
                let want_ranges = ranges_of(vector);
                let got_ranges: Vec<(u64, u64)> = plan
                    .ranges
                    .iter()
                    .map(|range| (range.from as u64, range.to as u64))
                    .collect();
                if got_ranges != want_ranges {
                    failures.push(format!(
                        "{name}: ranges {got_ranges:?}, want {want_ranges:?}"
                    ));
                }
            }
            (Ok(plan), Some(expected)) => failures.push(format!(
                "{name}: resolved to {:?}, want error {expected:?}",
                first_lines(&plan.text)
            )),
            (Err(error), None) => {
                failures.push(format!("{name}: failed with {error:?}, want success"))
            }
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {asserted} vectors disagree with lib/section.mjs:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );

    // Nothing may quietly leave the gate: every vector is either asserted here or
    // counted as pending a layer that does not exist yet.
    assert_eq!(
        asserted + pending.len(),
        vectors.len(),
        "vector accounting is wrong"
    );
    println!(
        "section vectors: {asserted} asserted, {} pending",
        pending.len()
    );
}

/// The grammar and the error text — no resolution.
///
/// The entry point is `parse_selectors`, not `parse_reference`: the corpus holds
/// comma-separated lists and line ranges, which one path selector reads as the errors
/// they are.
fn assert_grammar_vector(
    name: &str,
    reference: &str,
    expected_error: Option<&str>,
    failures: &mut Vec<String>,
) {
    match (parse_selectors(reference), expected_error) {
        (Err(error), Some(expected)) => {
            if error.message() != expected {
                failures.push(format!("{name}: got {error:?}, want {expected:?}"));
            }
        }
        (Ok(_), None) => {}
        (Ok(parsed), Some(expected)) => failures.push(format!(
            "{name}: parsed to {:?}, want error {expected:?}",
            parsed.canonical
        )),
        (Err(error), None) => failures.push(format!("{name}: failed with {error:?}, want success")),
    }
}

/// The line ranges a resolution row expects, as `[[from, to], …]`.
fn ranges_of(vector: &Value) -> Vec<(u64, u64)> {
    vector["ranges"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    let pair = row.as_array().cloned().unwrap_or_default();
                    (
                        pair.first().and_then(Value::as_u64).unwrap_or(0),
                        pair.get(1).and_then(Value::as_u64).unwrap_or(0),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The first few lines of a section, so a failure message stays readable when the
/// text runs to a hundred lines.
fn first_lines(text: &str) -> String {
    let lines: Vec<&str> = text.lines().take(3).collect();
    let joined = lines.join("\\n");
    if text.lines().count() > 3 {
        format!("{joined}\\n…")
    } else {
        joined
    }
}

// ---------------------------------------------------------------------------
// A declaration whose header does not fit on one line
// ---------------------------------------------------------------------------
//
// Wrapping a parameter list is ordinary formatting, not an exotic spelling: the
// signature line ends with the opening `(`, the parameters follow on their own
// lines, and the `)` may share a line with the body's `{` or have a line to
// itself. The matcher reads lines, so this is the shape it has to follow past the
// end of the line the declaration starts on. The failure it guards against is not
// a wrong slice but *no match at all*: the name is visible in the file, and a
// reference to it must resolve. This mirrors the `test.mjs` block of the same
// name; the `wrapped-*` vectors are the same fixtures through the corpus.

/// A wrapped parameter list is still a declaration: the whole declaration, the
/// body alone, and the same declaration reached through its class scope.
#[test]
fn a_wrapped_parameter_list_is_still_a_declaration() {
    let source = fixture("test/fixtures/Wrapped.java");
    let lexer = lexer_for_path("Wrapped.java");

    let render = resolve_section(&source, "render", &*lexer).expect("the wrapped method");
    assert!(
        render.starts_with("    public String render("),
        "the selection starts at the declaration, not at its first parameter: {render:?}"
    );
    assert!(
        render.contains("\n            String name,\n"),
        "the wrapped parameters are included: {render:?}"
    );
    assert!(render.contains("\n            int quantity) {"));
    assert!(render.ends_with("return name + \" x\" + quantity;\n    }"));

    // The declaration is the file's own bytes.
    let from = source
        .find("    public String render(")
        .expect("the declaration");
    let close = from + source[from..].find("\n    }\n").expect("its closing brace");
    assert_eq!(&source[from..close + "\n    }".len()], render);

    // The body alone: the signature (wrapped across lines) is dropped whole, and
    // the span still starts after the `{` of the closing line.
    let body = resolve_section(&source, "render/-", &*lexer).expect("the body");
    assert_eq!("        return name + \" x\" + quantity;", body);
    let plan = plan_section(&source, "render/-", &*lexer).expect("a plan");
    assert_eq!(vec![(9, 9)], line_ranges(&plan));

    // A wrapped signature with a generic method's type parameters, and the same
    // declaration reached through its class scope.
    assert_eq!(
        render,
        resolve_section(&source, "Wrapped/render", &*lexer).unwrap()
    );
    let widest = resolve_section(&source, "widest", &*lexer).expect("the generic method");
    assert!(
        widest.starts_with("    public <T extends Comparable<T>> T widest("),
        "{widest:?}"
    );
    assert!(widest.contains("\n            T right) {"));
    assert!(widest.contains("left.compareTo(right)"));

    // The `+` scope reaches the annotation above a header that wraps.
    let annotated = resolve_section(&source, "toString/+", &*lexer).expect("the annotation");
    assert!(
        annotated.starts_with("    @Override\n    public String toString("),
        "{annotated:?}"
    );
}

/// A `throws` clause on its own line is part of the header, and a parameter list
/// that closes on a line of its own still ends at the body's brace.
#[test]
fn a_wrapped_throws_clause_is_part_of_the_header() {
    let source = fixture("test/fixtures/Wrapped.java");
    let lexer = lexer_for_path("Wrapped.java");

    let store = resolve_section(&source, "store", &*lexer).expect("the wrapped `throws`");
    assert!(store.contains("\n            int quantity)\n"), "{store:?}");
    assert!(
        store.contains("\n            throws IllegalStateException {"),
        "the `throws` line is part of the header: {store:?}"
    );
    assert!(store.contains("this.name = name;"));

    assert_eq!(
        "        this.name = name;",
        resolve_section(&source, "store/-", &*lexer).expect("its body")
    );

    // The class line wraps too: the type parameters, the `extends` and the
    // `implements` each get their own line, and the body opens after them.
    let source = fixture("test/fixtures/WrappedClass.java");
    let lexer = lexer_for_path("WrappedClass.java");
    let wrapped = resolve_section(&source, "Wrapped", &*lexer).expect("the wrapped class");
    assert!(
        wrapped.starts_with("public class Wrapped<\n"),
        "{wrapped:?}"
    );
    assert!(wrapped.contains("\n        U extends CharSequence>"));
    assert!(wrapped.contains("\n        implements Renderer<T> {"));
    assert!(
        wrapped.contains("public T best("),
        "the class body is the whole class: {wrapped:?}"
    );

    // The member whose parameters wrap is reachable through that class scope, and
    // by its own name.
    let best = resolve_section(&source, "best", &*lexer).expect("the member");
    assert_eq!(
        best,
        resolve_section(&source, "Wrapped/best", &*lexer).unwrap()
    );
    assert!(best.contains("\n            T right) {"), "{best:?}");
}

/// A wrapped header does not invent declarations: a call whose arguments wrap is
/// still a call, and a body-less member injects nothing.
#[test]
fn a_wrapped_header_does_not_invent_declarations() {
    let source = [
        "class Svc {",
        "    void run() {",
        "        wrappedCall(",
        "            1,",
        "            2);",
        "    }",
        "",
        "    void wrappedCall(",
        "            int a,",
        "            int b) {",
        "        work();",
        "    }",
        "}",
    ]
    .join("\n");
    let lexer = lexer_for_path("Svc.java");

    assert_eq!(
        "    void wrappedCall(\n            int a,\n            int b) {\n        work();\n    }",
        resolve_section(&source, "wrappedCall", &*lexer).expect("the declaration")
    );
    // The call inside `run` is reached only by naming its scope, and it is a
    // call, not a declaration there: nothing is injected for it.
    let error = resolve_section(&source, "run/wrappedCall", &*lexer)
        .expect_err("a call is not a declaration");
    assert_eq!(
        "no section named \"wrappedCall\" in \"run\"",
        error.to_string()
    );

    // A body-less member still has nothing to inject, however its header wraps:
    // the name is matched, and what it contributes is nothing at all.
    let iface = [
        "interface I {",
        "    void bar(",
        "            int x);",
        "    void baz() {",
        "        work();",
        "    }",
        "}",
    ]
    .join("\n");
    let lexer = lexer_for_path("I.java");
    assert_eq!(
        "    void baz() {\n        work();\n    }",
        resolve_section(&iface, "baz", &*lexer).expect("the member with a body")
    );
    let plan = plan_section(&iface, "bar", &*lexer).expect("the body-less member");
    assert_eq!("", plan.text, "a declaration with no body injects nothing");
    assert_eq!("declaration", plan.kind);
    assert_eq!(vec![(2, 2)], line_ranges(&plan));
}
