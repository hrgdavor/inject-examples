//! A cart, with its members where Rust keeps them: in the impls.

// The catalog is a region directive: the directive lines are never injected.
// #region catalog
/// The catalog the shop stocks.
pub const CATALOG: [&str; 3] = ["bolt", "nut", "washer"];
// #endregion

struct Cart {
    items: Vec<String>,
}

impl Cart {
    fn add(&mut self, x: String) {
        self.items.push(x);
    }
}

impl Cart {
    fn remove(&mut self) -> Option<String> {
        self.items.pop()
    }

    /// Run the method the name asks for. A `match` arm is an arm, not a block,
    /// so the literal is named by putting it on the `if` that holds the body.
    #[allow(dead_code)]
    pub fn dispatch(&mut self, method_name: &str) -> Option<usize> {
        if method_name == "count" {
            return Some(self.items.len());
        }
        None
    }

    fn legacy(&mut self) -> usize { //count
        self.items.len()
    }
}

/* A nested /* comment */ hides `fn decoy() {}` from the matcher. */
