<?php

class Cart
{
    public function add(string $item): string
    {
        // The heredoc body is data: the brace in it is not PHP syntax.
        $sql = <<<SQL
        insert into cart (item) values ('}') -- a decoy
        SQL;

        return $sql;
    }
}
