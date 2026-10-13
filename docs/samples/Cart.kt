class Cart {
    // The catalog is a region directive: the directive lines are never injected.
    // #region catalog
    val catalog = listOf("bolt", "nut", "washer")
    // #endregion

    /* Kotlin nests /* comments */, and a raw string hides a decoy: */
    val note = """fun decoy() {}"""

    @Deprecated("use add")
    fun add(item: String) {
        items.add(item)
    }

    fun dispatch(methodName: String) {
        if (methodName == "count") {
            println(catalog.size)
        }
        return
    }

    fun legacy() { //count
        println(catalog.size)
    }
}
