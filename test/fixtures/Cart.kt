class Cart {
    val note = """fun decoy() {}"""

    val banner = """
        class Decoy {
            fun hidden() {}
        }
    """

    val total = listOf(
        1,
        2,
    )

    fun add(item: String) {
        items.add(item)
    }

    fun remove(item: String) {
        items.remove(item)
    }
}
