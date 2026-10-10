use std::fmt::Display;

pub struct Cart<T> {
    publisher: String,
    pub_key: String,
    items: Vec<T>,
}

impl<T: Clone> Display for Cart<T> {
    fn render(&self) -> String {
        String::new()
    }
}

impl Cart<String> {
    fn add(&mut self, x: String) {
        self.items.push(x);
    }
}
