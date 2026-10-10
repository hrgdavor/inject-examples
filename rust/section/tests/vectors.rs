//! The parity gate: the golden vectors, against this implementation.
//!
//! `test/vectors/section-vectors.json` is the conformance set the JavaScript
//! matcher is held to, and the rule for a port is that it mirrors rather than
//! leads (`plans/zig-port.md` §2). So this test reads that file directly instead
//! of keeping a generated copy: the Zig port needs `tools/zig-vectors.mjs`
//! because it has no JSON reader, while Rust has one as a test-only dependency,
//! and a file that cannot drift is better than one that can.
//!
//! The vectors cover three things, and only the first is asserted today:
//!
//! - **grammar** and **grammar-error** — the reference grammar, exact error text.
//! - **warning** — the contradiction between `+`/`++` and `-`.
//! - **resolution** (`input` and `text` set) — needs the mask, scanner and
//!   matcher layers, which are not ported yet. Those vectors are counted and
//!   named, never silently skipped: `cargo test -- --nocapture` prints the count,
//!   and the assertion below fails if a vector is neither asserted nor counted.

use inject_sections::parse_reference;
use serde_json::Value;

/// Every vector, as parsed JSON. The file lives with the JavaScript suite, so the
/// path is relative to the crate (`rust/section/`).
fn vectors() -> Vec<Value> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/vectors/section-vectors.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
    serde_json::from_str(&text).expect("section-vectors.json is an array of vectors")
}

#[test]
fn reference_grammar_matches_the_vectors() {
    let vectors = vectors();
    let mut failures: Vec<String> = Vec::new();
    let mut asserted = 0;
    let mut pending: Vec<&str> = Vec::new();

    for vector in &vectors {
        let name = vector["name"].as_str().unwrap_or("<unnamed>");
        let reference = vector["reference"].as_str().unwrap_or("");
        let expected_error = vector["error"].as_str();

        // A vector with an input fixture or expected text resolves a section, so
        // it exercises the layers that are not written yet.
        if vector["input"].is_string() || vector["text"].is_string() {
            pending.push(name);
            continue;
        }

        asserted += 1;
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
        "reference grammar: {asserted} vectors asserted, {} pending the mask/scanner/matcher layers",
        pending.len()
    );
}
