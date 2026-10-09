//! A cart, with its members where Rust keeps them: in the impls.

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
}

/* A nested /* comment */ hides `fn decoy() {}` from the matcher. */
