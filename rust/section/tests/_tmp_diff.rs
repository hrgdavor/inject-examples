//! TEMPORARY differential harness (deleted before the task ends): the same cases the JavaScript
//! reference answered, through this port, so a divergence is named.

use inject_sections::resolver::plan_section;
use inject_sections::syntaxes::lexer_for_path;
use serde_json::Value;

fn read(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
    serde_json::from_str(&text).expect("json")
}

#[test]
fn the_port_agrees_with_the_reference_on_every_case() {
    let cases = read("_tmp_cases.json");
    let want = read("_tmp_ref.json");
    let cases = cases.as_array().unwrap();
    let want = want.as_array().unwrap();

    let mut failures: Vec<String> = Vec::new();
    for (index, (case, want)) in cases.iter().zip(want).enumerate() {
        let path = case["path"].as_str().unwrap_or("");
        let source = case["source"].as_str().unwrap_or("");
        let reference = case["reference"].as_str().unwrap_or("");
        let lexer = lexer_for_path(path);
        let got: Value = match plan_section(source, reference, &*lexer) {
            Ok(plan) => serde_json::json!({
                "text": plan.text,
                "kind": plan.kind,
                "startLine": plan.start_line,
                "endLine": plan.end_line,
                "ranges": plan.ranges.iter().map(|r| [r.from, r.to]).collect::<Vec<_>>(),
            }),
            Err(error) => serde_json::json!({ "error": error.to_string() }),
        };
        if &got != want {
            failures.push(format!(
                "#{index} {path} {reference:?}:\n    got  {got}\n    want {want}"
            ));
        }
    }

    if !failures.is_empty() {
        let show: Vec<&String> = failures.iter().take(60).collect();
        panic!(
            "{} of {} cases disagree with lib/section.mjs:\n{}",
            failures.len(),
            cases.len(),
            show.iter()
                .map(|line| line.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}
