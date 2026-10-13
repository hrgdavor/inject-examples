<?php

class Cart
{
    // The catalog is a region directive: the directive lines are never injected.
    // #region catalog
    public const CATALOG = ['bolt', 'nut', 'washer'];
    // #endregion

    public function add(string $item): string
    {
        // The heredoc body is data: the brace in it is not PHP syntax.
        $sql = <<<SQL
        insert into cart (item) values ('}') -- a decoy
        SQL;

        return $sql;
    }

    public function dispatch(string $methodName): ?int
    {
        if ($methodName == "count") {
            return count(self::CATALOG);
        }
        return null;
    }

    public function legacy() //count
    {
        return count(self::CATALOG);
    }
}
