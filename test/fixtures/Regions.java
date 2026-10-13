// A region directive names a block, and a name two blocks answer to is ambiguous
// — never the first in walk order. The two `dup` regions are at the same level,
// so a reference that names `dup` has two answers and must fail; the unnamed
// region and the class are here so a matcher cannot pass by finding one answer
// and ignoring the other.
public class Regions {
    // #region dup
    void first() { run(); }
    // #endregion

    // #region dup
    void second() { run(); }
    // #endregion

    // #region solo
    void only() { run(); }
    // #endregion
}
