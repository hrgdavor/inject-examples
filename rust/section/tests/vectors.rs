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
//! `parse_reference` (exact error text), **warning** for the `+`/`++` versus `-`
//! contradiction, and **resolution** through `plan_section` — comparing the text,
//! the 1-based inclusive line span and the matcher `kind`, or the error text for
//! the rows whose expected answer is an error. A vector that is neither asserted
//! nor counted as pending fails the accounting check at the end, so nothing can
//! quietly leave the gate.

use inject_sections::parse_reference;
use inject_sections::resolver::plan_section;
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
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(relative)
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
            assert_grammar_vector(vector, name, reference, expected_error, &mut failures);
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
                    ("startLine", vector["startLine"].as_u64(), plan.start_line as u64),
                    ("endLine", vector["endLine"].as_u64(), plan.end_line as u64),
                ] {
                    if want != Some(got) {
                        failures.push(format!("{name}: {field} {got}, want {want:?}"));
                    }
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
    assert_eq!(asserted + pending.len(), vectors.len(), "vector accounting is wrong");
    println!("section vectors: {asserted} asserted, {} pending", pending.len());
}

/// The grammar, the error text and the contradiction warning — no resolution.
fn assert_grammar_vector(
    vector: &Value,
    name: &str,
    reference: &str,
    expected_error: Option<&str>,
    failures: &mut Vec<String>,
) {
    match (parse_reference(reference), expected_error) {
        (Err(error), Some(expected)) => {
            if error.message() != expected {
                failures.push(format!("{name}: got {error:?}, want {expected:?}"));
            }
        }
        (Ok(parsed), None) => {
            let expected = &vector["warning"];
            match (&parsed.warning, expected.is_null()) {
                (Some(warning), false) => {
                    let mismatches = [
                        ("kind", expected["kind"].as_str(), warning.kind),
                        ("kept", expected["kept"].as_str(), warning.kept),
                        ("dropped", expected["dropped"].as_str(), warning.dropped),
                    ]
                    .into_iter()
                    .filter(|(_, want, got)| *want != Some(*got))
                    .map(|(field, want, got)| format!("{field}: got {got}, want {want:?}"))
                    .collect::<Vec<_>>();
                    if !mismatches.is_empty() {
                        failures.push(format!("{name}: {}", mismatches.join(", ")));
                    }
                    if !warning.message.contains("contradicts") {
                        failures.push(format!(
                            "{name}: warning message {:?} says nothing about the contradiction",
                            warning.message
                        ));
                    }
                }
                (Some(warning), true) => {
                    failures.push(format!("{name}: warned {warning:?}, want no warning"));
                }
                (None, false) => {
                    failures.push(format!("{name}: no warning, want {expected}"));
                }
                (None, true) => {}
            }
        }
        (Ok(parsed), Some(expected)) => failures.push(format!(
            "{name}: parsed to {:?}, want error {expected:?}",
            parsed.canonical
        )),
        (Err(error), None) => {
            failures.push(format!("{name}: failed with {error:?}, want success"))
        }
    }
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
