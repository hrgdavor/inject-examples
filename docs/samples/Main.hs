-- | A tiny store: a binding, the signature that labels it, and a record.
module Main where

-- The catalog is a region directive: the directive lines are never injected.
-- #region catalog
catalog :: [String]
catalog = ["bolt", "nut", "washer"]

-- #endregion

-- | Add two numbers; `+add` brings the signature above along.
add :: Int -> Int -> Int
add x y = x + y

data Cart = Cart { items :: [Int] }

-- | The dispatch is a binding like any other; `dispatch` names it and the
-- signature above it is what `+dispatch` brings along.
dispatch :: String -> [Int] -> [Int]
dispatch methodName items = if methodName == "count" then items else []

legacy :: [Int] -> Int -- count
legacy items = length items
