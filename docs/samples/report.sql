-- A region directive is how a language without members is still addressable,
-- and the doubled quote keeps the brace inside the string: 'it''s a } decoy'.
-- #region monthly
select
    date_trunc('month', placed_at) as month,
    count(*) as orders
from orders
where note <> 'it''s a } decoy'
group by 1;
-- #endregion
