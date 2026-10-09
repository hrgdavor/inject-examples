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
