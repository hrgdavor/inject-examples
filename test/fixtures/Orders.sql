-- #region totals
SELECT count(*) AS orders, sum(total) AS revenue FROM orders;
-- #endregion

CREATE TABLE orders (
    id INT,
    total INT
);
