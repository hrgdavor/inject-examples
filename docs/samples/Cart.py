class Cart:
    """A cart of items.

    The triple-quoted text hides a decoy from the matcher:
    def decoy(self):
        pass
    """

    def add(self, item):
        self.items.append(item)

    def total(self):
        return len(self.items)
