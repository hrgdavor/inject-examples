class Wrapped:
    def render(
            self,
            name: str,
            quantity: int) -> str:
        return f"{name} x{quantity}"

    def label(self) -> str:
        return self.name

    def describe(
            self,
            prefix: str):
        first = prefix + self.name
        return first
