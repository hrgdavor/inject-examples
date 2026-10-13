class Cart:
    """A cart, kept small: the shapes a `#`-comment language needs."""

    # The catalog is a class attribute, named by a region directive.
    # #region catalog
    CATALOG = ["bolt", "nut", "washer"]
    # #endregion

    def legacy(self):  # count
        return len(self.CATALOG)

    def dispatch(self, method_name):
        if method_name == "count":
            return len(self.CATALOG)
        if method_name == "clear":
            self.CATALOG.clear()
        return None
