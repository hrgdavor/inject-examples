class Cart:
    """A cart of items.

    The triple-quoted text hides a decoy from the matcher:
    def decoy(self):
        pass
    """

    # The catalog is a region directive: the directive lines are never injected.
    # #region catalog
    CATALOG = ["bolt", "nut", "washer"]
    # #endregion

    @property
    def catalog(self):
        return list(self.CATALOG)

    def add(self, item):
        self.items.append(item)

    def dispatch(self, method_name):
        if method_name == "count":
            return len(self.items)
        if method_name == "clear":
            self.items.clear()
        return None

    def legacy(self):  #count
        return len(self.items)

    def total(self):
        return len(self.items)
